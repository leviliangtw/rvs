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
      // Returns '' when no real title is available yet: the player's title overlay
      // (`[data-uia="video-title"]`) auto-hides, and Netflix's `document.title` is
      // often just "Netflix" — neither is a usable title. Surfacing '' lets the
      // share logic wait for the real title instead of broadcasting (and latching)
      // a placeholder.
      getTitle() {
        const el = document.querySelector('[data-uia="video-title"]');
        let title = el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
        if (!title) {
          const docTitle = document.title.replace(/\s*-\s*Netflix\s*$/i, '').trim();
          title = /^netflix$/i.test(docTitle) ? '' : docTitle;
        }
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
// 2. Connection state — mirrored from background purely to push status snapshots
//    to the popup (see section 7). The anti-feedback lock and command sequencing
//    live inside the active player (players.js), not here.
// ----------------------------------------------------------------------------
let connectionStatus = 'Disconnected';
let peersCount = 0;

let videoElement = null;
let isReadEventListenersBound = false;

// "Now Watching" sharing: the peer's current media, and the last url+title we
// shared (so we only re-broadcast when either actually changes).
let peerMedia = null;
let lastSharedKey = null;

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

// Per-tab "prefill" Room ID: the ID the popup shows before the user connects.
// Persisted separately from the active room (so it never triggers auto-rejoin on
// reload), so reopening the popup on this tab keeps the *same* suggested ID
// instead of generating a fresh random one each time. isRoomPrefilled() — "has
// this tab been seeded yet?" — is just whether that key is set, so the flag
// lives in sessionStorage (per-tab) rather than resetting with the popup.
const PREFILLED_ROOM_KEY = '__rvs_prefilled_room';

function getPrefilledRoom() {
  try { return sessionStorage.getItem(PREFILLED_ROOM_KEY); } catch (_) { return null; }
}
function setPrefilledRoom(roomId) {
  try { sessionStorage.setItem(PREFILLED_ROOM_KEY, roomId); } catch (_) {}
}
function isRoomPrefilled() {
  return getPrefilledRoom() !== null;
}

// Random 6-char Room ID (A-Z0-9), matching the popup's Generate button.
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
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

// Rebind when the SPA adds OR swaps the <video> element. Netflix replaces the
// element on an episode change; staying bound to the old (now-detached) one left
// our READ listeners firing on a dead element, so local actions stopped being
// broadcast. (Writes are unaffected — the bridge / direct path re-look-up the
// element.) A swapped element also signals a navigation, so it's a share trigger
// (see section 6) — but that's the observer's call, not findAndBindVideo's job.
const videoObserver = new MutationObserver(() => {
  const current = document.querySelector('video');
  if (current && current !== videoElement) {
    isReadEventListenersBound = false;
    videoElement = null;
    findAndBindVideo();
    shareWhenTitleSettles(); // new <video> usually means a new title — re-share it
  }
});
videoObserver.observe(document.documentElement, { childList: true, subtree: true });

// Bind the READ-path listeners to the current <video>, nothing more. Idempotent
// (bindVideoReadEvents self-guards), so the write path can call it to re-find a
// swapped-out element without side effects.
function findAndBindVideo() {
  const video = document.querySelector('video');
  if (!video) return;

  videoElement = video;
  bindVideoReadEvents(video);

  // Drain a command the player parked while waiting for the element (direct path;
  // no-op on Netflix, which never parks).
  player.onVideoReady();
}

function bindVideoReadEvents(video) {
  if (isReadEventListenersBound) return;

  console.log('[RVS] Video element found, listeners attached.');

  // Don't broadcast local actions while the player is applying a remote command
  // (anti-feedback) or while the peer is watching a different video.
  const shouldSkipReadBroadcast = () => player.isApplying() || isDifferentVideoFromPeer();

  video.addEventListener('play', () => {
    if (shouldSkipReadBroadcast()) return;
    port.postMessage({ action: 'play', time: video.currentTime });
  });

  video.addEventListener('pause', () => {
    if (shouldSkipReadBroadcast()) return;
    port.postMessage({ action: 'pause', time: video.currentTime });
  });

  video.addEventListener('seeked', () => {
    if (shouldSkipReadBroadcast()) return;
    port.postMessage({ action: 'seek', time: video.currentTime });
  });

  video.addEventListener('ratechange', () => {
    if (shouldSkipReadBroadcast()) return;
    port.postMessage({ action: 'rate', rate: video.playbackRate });
  });

  isReadEventListenersBound = true;
}

// Backs the direct (YouTube) player: returns the bound <video>, re-finding it if
// the SPA swapped the element out, or null if none exists yet. Injected into
// createDirectPlayer so the player file has no implicit dependency on this state.
function getBoundVideo() {
  if (videoElement && !videoElement.isConnected) {
    isReadEventListenersBound = false;
    videoElement = null;
    findAndBindVideo();
  }
  return videoElement || document.querySelector('video');
}

// ----------------------------------------------------------------------------
// 6. "Now Watching" — share the current video's title + URL with the peer so each
//    user can see (and open) what the other is browsing.
// ----------------------------------------------------------------------------

// Best-effort local media, or null when not on a watch page. `title` is '' until
// the real title lands in the DOM (site.getTitle() suppresses the bare-site
// placeholder), so the share logic below can wait for it instead of broadcasting a
// junk title.
function getLocalMedia() {
  if (!site.isWatchPage()) return null;
  return { url: location.href, title: site.getTitle() };
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

// Broadcast the local video to the peer. Guarded so we only emit when paired; the
// background also drops media_info unless two peers are present. De-dupes on
// title+url (not url alone) so an unchanged re-check is a no-op while a later title
// correction — same url, changed title — still goes out. To force a re-send (e.g.
// just after pairing), clear `lastSharedKey` before calling.
function shareMediaInfo() {
  if (connectionStatus !== 'Connected' || peersCount !== 2) return;
  const media = getLocalMedia();
  if (!media) return;
  const title = media.title || media.url; // last-resort fallback so the link still works
  const key = media.url + '\n' + title;
  if (key === lastSharedKey) return;
  lastSharedKey = key;
  port.postMessage({ action: 'media_info', title, url: media.url });
}

// Share triggers — event-driven, replacing the old blind 4s re-share. We share on
// real changes only (navigation, a new <video>, fresh pairing). Because a freshly
// navigated title often lands in the DOM a beat after the URL, each trigger opens a
// short *bounded* settle window that re-checks until the title resolves (then
// stops) — so there's no perpetual polling and no latching of a placeholder title.
const SETTLE_WINDOW_MS = 6000; // how long to wait for the title to appear after a trigger
const SETTLE_POLL_MS = 500;    // re-check cadence within that window
let settleTimer = null;
let settleUntil = 0;

function shareWhenTitleSettles() {
  settleUntil = Date.now() + SETTLE_WINDOW_MS;
  if (settleTimer) return; // a window is already open — we just extended its deadline
  const tick = () => {
    settleTimer = null;
    if (connectionStatus !== 'Connected' || peersCount !== 2) return;
    const media = getLocalMedia();
    if (!media) return; // not on a watch page
    if (media.title) { shareMediaInfo(); return; } // real title settled → share and stop
    if (Date.now() < settleUntil) { // title not ready yet → keep waiting, bounded
      settleTimer = setTimeout(tick, SETTLE_POLL_MS);
      return;
    }
    shareMediaInfo(); // window expired → share with the URL fallback so the peer
                      // still gets the new video, even if it stays titleless
  };
  tick();
}

// SPA navigation can change the video *without* swapping the <video> element (so the
// MutationObserver in section 5 won't fire). Cover those route changes explicitly:
// back/forward (popstate), YouTube's own post-navigation event, and any <title>
// change — a reliable cross-site proxy for "the page navigated" that also fires when
// a late title finally settles. (History pushState/replaceState can't be hooked from
// here: the page's router runs in the main world and uses a different History object.)
window.addEventListener('popstate', shareWhenTitleSettles);
document.addEventListener('yt-navigate-finish', shareWhenTitleSettles);

const titleEl = document.querySelector('title');
if (titleEl) {
  new MutationObserver(shareWhenTitleSettles).observe(titleEl, { childList: true, characterData: true, subtree: true });
}

// ----------------------------------------------------------------------------
// 7. Popup channel — push-based. The popup opens a dedicated port (rvs-popup);
//    we push a status snapshot on connect and again whenever state changes, so
//    the popup never has to poll. CONNECT/DISCONNECT arrive over the same port.
// ----------------------------------------------------------------------------
let popupPort = null;

// The snapshot the popup renders. Seeds a stable per-tab Room ID once, so
// reopening the popup shows the same suggested ID instead of a new random one.
function buildStatus() {
  if (!isRoomPrefilled()) setPrefilledRoom(generateRoomId());
  return {
    kind: 'status',
    status: connectionStatus,
    peersCount,
    peerMedia,
    // Active (connected) room wins; otherwise the stable per-tab suggestion.
    // Both come from sessionStorage, so the popup reflects this exact tab.
    roomId: getActiveRoom() || getPrefilledRoom(),
  };
}

// Push the full snapshot to the popup, if one is open. Called on connect and on
// every real state change, so the popup re-renders only when something changed.
function pushStatus() {
  if (!popupPort) return;
  try { popupPort.postMessage(buildStatus()); } catch (_) {}
}

// Latency travels on its own narrow message so the 5s ping loop refreshes just
// that readout instead of re-rendering the whole popup (a full snapshot on a timer
// is the polling the push model replaced). pushLatency(latency) sends a fresh
// measurement; clearLatency() resets the readout to '--' (on unpair, or while a new
// pairing is still measuring). renderStatus never touches latency.
function pushLatency(latency) {
  if (!popupPort) return;
  try { popupPort.postMessage({ kind: 'latency', latency }); } catch (_) {}
}
function clearLatency() { pushLatency(null); }

chrome.runtime.onConnect.addListener((p) => {
  if (p.name !== 'rvs-popup') return;
  popupPort = p;

  p.onMessage.addListener((message) => {
    if (message.action === 'CONNECT') {
      connectionStatus = 'Connecting';
      lastSharedKey = null;
      peerMedia = null;
      setActiveRoom(message.roomId); // remember the session so it survives navigation
      setPrefilledRoom(message.roomId); // keep the popup's suggestion in sync with the room in use
      port.postMessage({ action: 'CONNECT', roomId: message.roomId });
      pushStatus();
    } else if (message.action === 'DISCONNECT') {
      clearActiveRoom(); // explicit disconnect: don't auto-rejoin on reload
      port.postMessage({ action: 'DISCONNECT' });
      connectionStatus = 'Disconnected';
      peersCount = 0;
      peerMedia = null;
      lastSharedKey = null;
      pushStatus();
      clearLatency();
    }
  });

  p.onDisconnect.addListener(() => {
    if (popupPort === p) popupPort = null;
  });

  pushStatus(); // initial snapshot; latency stays '--' until the next measurement arrives
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
      // Newly paired: tell the peer what we're watching right now. Clear the de-dupe
      // key so the current video is (re)sent even if unchanged since last session.
      if (peersCount === 2) { lastSharedKey = null; shareWhenTitleSettles(); }
    } else if (msg.status === 'peer_disconnected') {
      peersCount = 1;
      peerMedia = null;
      // TODO: more robust handling of mid-session disconnects (e.g. pause and alert, or even remove the peer count limit and just alert?)
      // alert('Remote user has disconnected.');
    }
    pushStatus();
    clearLatency(); // pairing changed; '--' until the first measurement of the new pairing
    return;
  }

  if (action === 'latency_update') {
    pushLatency(msg.latency);
    return;
  }

  if (action === 'media_info') {
    // The peer's current video. Stored for the popup to render; the URL is
    // validated there before it's turned into a clickable link.
    peerMedia = msg.url ? { title: msg.title || msg.url, url: msg.url } : null;
    pushStatus();
    return;
  }

  if (action === 'error') {
    connectionStatus = 'Disconnected';
    peersCount = 0;
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
    pushStatus();
    clearLatency();
    return;
  }

  // Ignore remote playback commands while the peer is on a different video.
  // peerMedia is kept current by the media_info handler above.
  if (isDifferentVideoFromPeer()) return;

  // Sync command — the active player applies it (and parks/retries internally
  // on the direct path if the <video> isn't ready yet).
  player.apply(msg);
});
