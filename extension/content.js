const isNetflix = window.location.hostname.includes('netflix.com');

// ----------------------------------------------------------------------------
// 1. Site adapter — the only YouTube/Netflix difference on the READ/metadata side.
//    Picked once, here, so the rest of this file is site-agnostic.
// ----------------------------------------------------------------------------
function makeSite() {
  if (isNetflix) {
    return {
      isWatchPage: () => location.pathname.startsWith('/watch'),
      // Best-effort title from the page DOM (content scripts share the DOM).
      getTitle() {
        const el = document.querySelector('[data-uia="video-title"]');
        let title = el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
        if (!title) title = document.title.replace(/\s*-\s*Netflix\s*$/i, '').trim();
        return title;
      },
    };
  }
  return {
    isWatchPage: () => location.pathname === '/watch' || location.pathname.startsWith('/shorts/'),
    getTitle() {
      const el = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.ytd-watch-metadata');
      let title = el ? el.textContent.trim() : '';
      if (!title) title = document.title.replace(/\s*-\s*YouTube\s*$/i, '').trim();
      return title;
    },
  };
}
const site = makeSite();

// ----------------------------------------------------------------------------
// 2. Connection state — mirrored from background purely to answer the popup's
//    GET_STATUS. The anti-feedback lock and command sequencing live inside the
//    active player (players.js), not here.
// ----------------------------------------------------------------------------
let connectionStatus = 'Disconnected';
let peersCount = 0;
let oneWayLatency = 0;

let videoElement = null;
let eventListenersBound = false;

// "Now Watching" sharing: the peer's current media, and the last URL we shared
// (so we only re-broadcast when the local user navigates to a different video).
let peerMedia = null;
let lastSharedUrl = null;

// ----------------------------------------------------------------------------
// 3. Per-tab active room, persisted in sessionStorage so a full-page navigation
//    (e.g. clicking the peer's link to "join" their video) auto-rejoins the room.
//    sessionStorage is per-tab and same-origin, so other/new tabs start fresh.
// ----------------------------------------------------------------------------
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

// ----------------------------------------------------------------------------
// 4. Port to background service worker + the active player.
//    Running the WebSocket in background bypasses the page's CSP (Netflix blocks
//    ws:// connections from content scripts via its strict connect-src). The open
//    port also keeps the MV3 service worker alive for the lifetime of the tab.
// ----------------------------------------------------------------------------
const port = chrome.runtime.connect({ name: 'rvs-sync' });

console.log('[RVS] Content script injected.');

// The write path is fully encapsulated per site (see players.js): YouTube writes
// the <video> directly; Netflix drives the official player API through the
// main-world bridge (direct writes there trigger error M7375). Only the direct
// player needs to reach the bound <video>, so we inject getBoundVideo() into it.
const player = isNetflix
  ? window.RVS.createBridgePlayer()
  : window.RVS.createDirectPlayer({ getVideo: getBoundVideo });

// Resume an active session after a navigation/reload within this tab (e.g. after
// clicking the peer's link to "join" their video).
const resumeRoom = getActiveRoom();
if (resumeRoom) {
  connectionStatus = 'Connecting';
  port.postMessage({ action: 'CONNECT', roomId: resumeRoom });
}

// ----------------------------------------------------------------------------
// 5. READ path — discover the <video> and capture local user actions.
//    The SPA injects/replaces the element ~1-2s after load, so we observe the DOM.
//    On Netflix this path is still active (reads are unchanged); only writes go
//    through the bridge. The <video> here is effectively read-only on Netflix.
// ----------------------------------------------------------------------------
findAndBindVideo();

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

  // Drain a command the player parked while waiting for the element (direct path;
  // no-op on Netflix, which never parks).
  player.onVideoReady();
}

function bindVideoEvents(video) {
  if (eventListenersBound) return;

  console.log('[RVS] Video element found, listeners attached.');

  // Don't broadcast local actions while the player is applying a remote command
  // (anti-feedback) or while the peer is watching a different video.
  const shouldSkipBroadcast = () => player.isApplying() || isDifferentVideoFromPeer();

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

// Backs the direct (YouTube) player: returns the bound <video>, re-finding it if
// the SPA swapped the element out, or null if none exists yet. Injected into
// createDirectPlayer so the player file has no implicit dependency on this state.
function getBoundVideo() {
  if (videoElement && !videoElement.isConnected) {
    eventListenersBound = false;
    videoElement = null;
    findAndBindVideo();
  }
  return videoElement || document.querySelector('video');
}

// ----------------------------------------------------------------------------
// 6. "Now Watching" — share the current video's title + URL with the peer so each
//    user can see (and open) what the other is browsing.
// ----------------------------------------------------------------------------

// Best-effort local media, or null when not on a watch page. Falls back to the URL.
function getLocalMedia() {
  if (!site.isWatchPage()) return null;
  const url = location.href;
  const title = site.getTitle();
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

// Periodically re-share the local video so the peer follows navigation to a new
// title (covers SPA route changes that reuse the same <video>). Self-guards on
// connection state, and only emits when the URL actually changed.
setInterval(() => shareMediaInfo(false), 4000);

// ----------------------------------------------------------------------------
// 7. Popup messages (CONNECT / DISCONNECT / GET_STATUS).
// ----------------------------------------------------------------------------
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
// 8. Sync commands and state updates from background.
// ----------------------------------------------------------------------------
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

  // Sync command — the active player applies it (and parks/retries internally
  // on the direct path if the <video> isn't ready yet).
  player.apply(msg);
});
