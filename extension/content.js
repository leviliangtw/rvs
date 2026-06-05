const isNetflix = window.location.hostname.includes('netflix.com');

// Local state — kept in sync with background via port messages
let connectionStatus = 'Disconnected';
let peersCount = 0;
let oneWayLatency = 0;
let ignoreSyncEvents = false;

let videoElement = null;
let eventListenersBound = false;

// "Now Watching" sharing: the peer's current media, and the last URL we shared
// (so we only re-broadcast when the local user navigates to a different video).
let peerMedia = null;
let lastSharedUrl = null;

// Per-tab active room, persisted in sessionStorage so a full-page navigation
// (e.g. clicking the peer's link to "join" their video) auto-rejoins the room.
// sessionStorage is per-tab and same-origin, so other/new tabs start disconnected.
const ACTIVE_ROOM_KEY = '__rvs_active_room';

function getActiveRoom() {
  try { return sessionStorage.getItem(ACTIVE_ROOM_KEY); } catch (_) { return null; }
}
function setActiveRoom(roomId) {
  try { sessionStorage.setItem(ACTIVE_ROOM_KEY, roomId); } catch (_) {}
}
function clearActiveRoom() {
  try { sessionStorage.removeItem(ACTIVE_ROOM_KEY); } catch (_) {}
}

// Sync command parked while the video element isn't in the DOM yet (YouTube/direct path).
let pendingSyncMsg = null;

// Netflix main-world bridge command sequencing + ack-driven event re-enable
let cmdSeq = 0;
let ignoreResetTimer = null;

// Persistent port to background service worker.
// Running the WebSocket there bypasses the page's Content Security Policy (Netflix blocks
// ws:// connections initiated from content scripts via its strict connect-src CSP).
// The open port also keeps the MV3 service worker alive for the lifetime of the tab.
const port = chrome.runtime.connect({ name: 'rvs-sync' });

console.log('[RVS] Content script injected.');

// Resume an active session after a navigation/reload within this tab (e.g. after
// clicking the peer's link to "join" their video).
const resumeRoom = getActiveRoom();
if (resumeRoom) {
  connectionStatus = 'Connecting';
  port.postMessage({ action: 'CONNECT', roomId: resumeRoom });
}

findAndBindVideo();

// MutationObserver reacts instantly when the SPA adds/replaces the <video> element.
// Used for the READ path on both sites (capturing local user actions) and the
// WRITE path on YouTube.
const videoObserver = new MutationObserver(() => {
  if (!eventListenersBound) findAndBindVideo();
});
videoObserver.observe(document.documentElement, { childList: true, subtree: true });

function findAndBindVideo() {
  const video = document.querySelector('video');
  if (!video) return;

  videoElement = video;
  bindVideoEvents(video);

  // A new <video> usually means the SPA navigated to a different title — share it.
  shareMediaInfo(false);

  // Drain a parked command now that the video exists (YouTube/direct path)
  if (pendingSyncMsg) {
    const { msg, timer } = pendingSyncMsg;
    pendingSyncMsg = null;
    clearTimeout(timer);
    applySync(msg);
  }
}

function bindVideoEvents(video) {
  if (eventListenersBound) return;

  console.log('[RVS] Video element found, listeners attached.');

  // Don't broadcast local actions while applying a remote command (anti-feedback)
  // or while the peer is watching a different video.
  const shouldSkipBroadcast = () => ignoreSyncEvents || isDifferentVideoFromPeer();

  video.addEventListener('play', () => {
    if (shouldSkipBroadcast()) return;
    port.postMessage({ action: 'play', time: video.currentTime });
  });

  video.addEventListener('pause', () => {
    if (shouldSkipBroadcast()) return;
    port.postMessage({ action: 'pause', time: video.currentTime });
  });

  video.addEventListener('seeked', () => {
    if (shouldSkipBroadcast()) return;
    port.postMessage({ action: 'seek', time: video.currentTime });
  });

  video.addEventListener('ratechange', () => {
    if (shouldSkipBroadcast()) return;
    port.postMessage({ action: 'rate', rate: video.playbackRate });
  });

  eventListenersBound = true;
}

// ----------------------------------------------------------------------------
// "Now Watching" — share the current video's title + URL with the peer so each
// user can see (and open) what the other is browsing.
// ----------------------------------------------------------------------------

// Only share on actual video pages, not the homepage/search/etc.
function isWatchPage() {
  if (isNetflix) return location.pathname.startsWith('/watch');
  return location.pathname === '/watch' || location.pathname.startsWith('/shorts/');
}

// Best-effort title from the page DOM (content scripts share the DOM, so no
// MAIN-world bridge is needed here). Falls back to the URL if nothing is found.
function getLocalMedia() {
  if (!isWatchPage()) return null;
  const url = location.href;
  let title = '';

  if (isNetflix) {
    const el = document.querySelector('[data-uia="video-title"]');
    if (el) title = el.textContent.replace(/\s+/g, ' ').trim();
    if (!title) title = document.title.replace(/\s*-\s*Netflix\s*$/i, '').trim();
  } else {
    const el = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.ytd-watch-metadata');
    if (el) title = el.textContent.trim();
    if (!title) title = document.title.replace(/\s*-\s*YouTube\s*$/i, '').trim();
  }

  return { title: title || url, url };
}

// Canonical video identity, so timestamps / playlist / query noise don't count
// as a "different" video. Returns e.g. "yt:VIDEOID" or "nf:NUMERICID", or null.
function getVideoId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.includes('netflix.com')) {
      const m = u.pathname.match(/\/watch\/(\d+)/);
      return m ? `nf:${m[1]}` : null;
    }
    if (host === 'youtu.be') return `yt:${u.pathname.slice(1)}`;
    if (u.pathname.startsWith('/shorts/')) return `yt:${u.pathname.split('/')[2] || ''}`;
    const v = u.searchParams.get('v');
    return v ? `yt:${v}` : null;
  } catch (_) {
    return null;
  }
}

// True only when we can confirm the peer is on a *different* video. Unknown
// (no peer media yet, or an unparseable URL) returns false, so sync isn't blocked
// during the brief post-pairing handshake or on unrecognized URLs.
function isDifferentVideoFromPeer() {
  if (!peerMedia || !peerMedia.url) return false;
  const local = getVideoId(location.href);
  const peer = getVideoId(peerMedia.url);
  if (!local || !peer) return false;
  return local !== peer;
}

// Broadcast the local video to the peer. Guarded so we only emit when paired;
// the background also drops media_info unless two peers are present. Pass
// force=true to re-send even if the URL hasn't changed (e.g. just after pairing).
function shareMediaInfo(force) {
  if (connectionStatus !== 'Connected' || peersCount !== 2) return;
  const media = getLocalMedia();
  if (!media) return;
  if (!force && media.url === lastSharedUrl) return;
  lastSharedUrl = media.url;
  port.postMessage({ action: 'media_info', title: media.title, url: media.url });
}

// Handle messages from popup (CONNECT, GET_STATUS)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'CONNECT') {
    connectionStatus = 'Connecting';
    lastSharedUrl = null;
    peerMedia = null;
    setActiveRoom(message.roomId); // remember the session so it survives navigation
    port.postMessage({ action: 'CONNECT', roomId: message.roomId });
    sendResponse({ success: true });
    return;
  }

  if (message.action === 'DISCONNECT') {
    clearActiveRoom(); // explicit disconnect: don't auto-rejoin on reload
    port.postMessage({ action: 'DISCONNECT' });
    connectionStatus = 'Disconnected';
    peersCount = 0;
    oneWayLatency = 0;
    peerMedia = null;
    lastSharedUrl = null;
    sendResponse({ success: true });
    return;
  }

  if (message.action === 'GET_STATUS') {
    sendResponse({
      status: connectionStatus,
      peersCount,
      latency: peersCount === 2 ? oneWayLatency : null,
      peerMedia,
    });
  }
});

// ----------------------------------------------------------------------------
// Netflix write path: forward commands to the main-world bridge (player API).
// Direct <video> writes trigger M7375, so on Netflix we never touch the element.
// ----------------------------------------------------------------------------
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const d = event.data;
  if (!d || typeof d !== 'object') return;

  if (d.__rvs === 'bridge-ready') {
    console.log('[RVS] Netflix bridge ready.');
  } else if (d.__rvs === 'ack') {
    if (!d.ok) console.warn('[RVS] Bridge command failed:', d.reason);
    // Resume event capture shortly after the bridge applied the command, so the
    // native events it produced (play/seeked/...) aren't re-broadcast.
    clearTimeout(ignoreResetTimer);
    ignoreResetTimer = setTimeout(() => { ignoreSyncEvents = false; }, 300);
  }
});

function applyViaBridge(msg) {
  ignoreSyncEvents = true;
  // Safety net: resume capture even if no ack arrives (player never appeared).
  clearTimeout(ignoreResetTimer);
  ignoreResetTimer = setTimeout(() => { ignoreSyncEvents = false; }, 4500);

  const offset = oneWayLatency / 1000;
  const cmd = { __rvs: 'cmd', id: ++cmdSeq, action: msg.action };
  if (msg.action === 'play' || msg.action === 'seek') {
    cmd.time = msg.time + offset;
  } else if (msg.action === 'rate') {
    cmd.rate = msg.rate;
  }
  window.postMessage(cmd, '*');
}

// Resilient seek for the direct (YouTube) path: waits for metadata if not ready.
function seekVideo(video, targetTime) {
  try {
    if (video.readyState >= 1) {
      video.currentTime = targetTime;
    } else {
      video.addEventListener('loadedmetadata', () => {
        try { video.currentTime = targetTime; } catch (_) {}
      }, { once: true });
    }
  } catch (err) {
    console.warn('[RVS] Seek failed:', err);
  }
}

// Apply a remote sync command. Returns false only on the direct path when no
// video element is available yet (so the caller can park and retry).
function applySync(msg) {
  // Netflix: always go through the bridge; it handles player readiness itself.
  if (isNetflix) {
    applyViaBridge(msg);
    return true;
  }

  // YouTube / direct path
  if (videoElement && !videoElement.isConnected) {
    eventListenersBound = false;
    videoElement = null;
    findAndBindVideo();
  }
  const video = videoElement || document.querySelector('video');
  if (!video) return false;

  ignoreSyncEvents = true;
  const offset = oneWayLatency / 1000;
  const { action } = msg;

  if (action === 'play') {
    seekVideo(video, Math.min(video.duration || Infinity, msg.time + offset));
    video.play().catch((err) => console.error('[RVS] Play failed:', err));
  } else if (action === 'pause') {
    video.pause();
  } else if (action === 'seek') {
    seekVideo(video, Math.min(video.duration || Infinity, msg.time + offset));
  } else if (action === 'rate') {
    video.playbackRate = msg.rate;
  }

  setTimeout(() => { ignoreSyncEvents = false; }, 250);
  return true;
}

// Handle sync commands and state updates from background
port.onMessage.addListener((msg) => {
  const { action } = msg;

  if (action === 'state') {
    peersCount = msg.peersCount;
    if (msg.status === 'connected') {
      connectionStatus = 'Connected';
      // Newly paired: tell the peer what we're watching right now.
      if (peersCount === 2) shareMediaInfo(true);
    } else if (msg.status === 'peer_disconnected') {
      peersCount = 1;
      peerMedia = null;
      // TODO: more robust handling of mid-session disconnects (e.g. pause and alert, or even remove the peer count limit and just alert?)
      // alert('Remote user has disconnected.');
    }
    return;
  }

  if (action === 'latency_update') {
    oneWayLatency = msg.latency;
    return;
  }

  if (action === 'media_info') {
    // The peer's current video. Stored for the popup to render; the URL is
    // validated there before it's turned into a clickable link.
    peerMedia = msg.url ? { title: msg.title || msg.url, url: msg.url } : null;
    return;
  }

  if (action === 'error') {
    connectionStatus = 'Disconnected';
    peersCount = 0;
    oneWayLatency = 0;
    peerMedia = null;
    // Connection-level failures (e.g. server unavailable) disconnect silently and
    // keep the session so a later reload can retry; actionable server errors (room
    // full, invalid room) surface to the user and stop auto-rejoin.
    if (msg.silent) {
      console.warn(`[RVS] ${msg.message}`);
    } else {
      clearActiveRoom();
      alert(`[Sync Error] ${msg.message}`);
    }
    return;
  }

  // Ignore remote playback commands while the peer is on a different video.
  // peerMedia is kept current by the media_info handler above.
  if (isDifferentVideoFromPeer()) return;

  // Sync command. On the direct path, park and retry if the video isn't ready.
  if (!applySync(msg)) {
    if (pendingSyncMsg) clearTimeout(pendingSyncMsg.timer);
    const timer = setTimeout(() => {
      pendingSyncMsg = null;
      console.warn('[RVS] Sync command dropped: no video after 5s.');
    }, 5000);
    pendingSyncMsg = { msg, timer };
  }
});

// Periodically re-share the local video so the peer follows navigation to a new
// title (covers SPA route changes that reuse the same <video>). Self-guards on
// connection state, and only emits when the URL actually changed.
setInterval(() => shareMediaInfo(false), 4000);
