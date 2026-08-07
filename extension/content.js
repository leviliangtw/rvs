// Injected on <all_urls>, not scoped via host_permissions, so corporate
// sandbox/DLP policies can't block it entirely. CONNECT/DISCONNECT/GET_STATUS
// work on any page; the hostname check below only gates the video-specific
// integration in initVideoIntegration().
const hostname = window.location.hostname;
const isNetflix = window.RVS.isHost(hostname, 'netflix.com');
const isYouTube = window.RVS.isHost(hostname, 'youtube.com') || window.RVS.isHost(hostname, 'youtu.be');

// Mirrored from background purely to answer the popup's GET_STATUS — see
// connection-state.js for what it owns.
const connectionState = window.RVS.createConnectionState();

// content.js's own broadcast-dedup cache (the last { url, title } we shared)
// — not part of connectionState, since it's unrelated to connection status.
/** @type {{ url: string, title: string } | null} */
let lastSentMediaInfo = null;

// The write-path player adapter and the media-sharing broadcaster only exist
// on YouTube/Netflix (see initVideoIntegration below) — left null off-site so
// the message handlers can skip video-specific work instead of erroring.
/** @type {RvsPlayer | null} */
let player = null;
/** @type {((force: boolean) => void) | null} */
let shareMediaInfo = null;

// Per-tab active room, persisted in sessionStorage so a full-page navigation
// (e.g. clicking the peer's link) auto-rejoins the room.
const ACTIVE_ROOM_KEY = '__rvs_active_room';

// Per-tab "prefill" Room ID: what the popup shows before the user connects.
// Kept separate from the active room so it never triggers auto-rejoin.
const PREFILLED_ROOM_KEY = '__rvs_prefilled_room';

function getActiveRoom() {
  try { return sessionStorage.getItem(ACTIVE_ROOM_KEY); } catch (_) { return null; }
}
/** @param {string} roomId */
function setActiveRoom(roomId) {
  try { sessionStorage.setItem(ACTIVE_ROOM_KEY, roomId); } catch (_) {}
}
function clearActiveRoom() {
  try { sessionStorage.removeItem(ACTIVE_ROOM_KEY); } catch (_) {}
}

function getPrefilledRoom() {
  try { return sessionStorage.getItem(PREFILLED_ROOM_KEY); } catch (_) { return null; }
}
/** @param {string} roomId */
function setPrefilledRoom(roomId) {
  try { sessionStorage.setItem(PREFILLED_ROOM_KEY, roomId); } catch (_) {}
}
function isRoomPrefilled() {
  return getPrefilledRoom() !== null;
}

// Active room wins over the prefilled suggestion.
function getEffectiveRoomId() {
  return getActiveRoom() || getPrefilledRoom();
}

/** @param {string} url */
function getVideoId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    // Reuses isHost() rather than a loose substring check — this runs on
    // peerMediaInfo.url too, which arrives over the network from the peer.
    if (window.RVS.isHost(host, 'netflix.com')) {
      const m = u.pathname.match(/\/watch\/(\d+)/);
      return m ? `nf:${m[1]}` : null;
    }
    if (window.RVS.isHost(host, 'youtube.com') || window.RVS.isHost(host, 'youtu.be')) {
      if (window.RVS.isHost(host, 'youtu.be')) return `yt:${u.pathname.slice(1)}`;
      if (u.pathname.startsWith('/shorts/')) return `yt:${u.pathname.split('/')[2] || ''}`;
      const v = u.searchParams.get('v');
      return v ? `yt:${v}` : null;
    }
    return null;
  } catch (_) {
    return null;
  }
}

// True only when we can confirm the peer is on a different video. Unknown
// (no peer media yet, or an unparseable URL) returns false, so sync isn't
// blocked during the post-pairing handshake or on unrecognized URLs.
function isDifferentVideoFromPeer() {
  const { peerMediaInfo } = connectionState.getSnapshot();
  if (!peerMediaInfo || !peerMediaInfo.url) return false;
  const local = getVideoId(location.href);
  const peer = getVideoId(peerMediaInfo.url);
  if (!local || !peer) return false;
  return local !== peer;
}

/** @param {any} msg */
function handlePortMessage(msg) {
  const { action } = msg;
  if (action === 'state' || action === 'error') {
    console.log(`[RVS] port message: ${JSON.stringify(msg)}`);
  }

  if (action === 'state') {
    const { confirmedRoomId, isJustPaired } = connectionState.handleState({
      status: msg.status,
      peersCount: msg.peersCount,
      roomId: msg.roomId,
    });
    // background is the authoritative room tracker (keyed by tab, not
    // origin) — persist it here too so this origin's sessionStorage is
    // correct even after a cross-origin navigation started it out empty.
    if (confirmedRoomId) setActiveRoom(confirmedRoomId);
    // Newly paired: tell the peer what we're watching right now (no-op off-site).
    if (isJustPaired && shareMediaInfo) shareMediaInfo(true);
    return;
  }

  if (action === 'latency_update') {
    connectionState.handleLatencyUpdate(msg.latency);
    return;
  }

  if (action === 'media_info') {
    // The peer's current video, stored for the popup — the URL is validated
    // there before it's turned into a clickable link.
    connectionState.handleMediaInfo({ title: msg.title, url: msg.url });
    return;
  }

  if (action === 'error') {
    connectionState.handleError();
    // Connection-level failures (e.g. server unavailable) disconnect silently
    // and keep the session so a reload can retry; actionable server errors
    // (room full, invalid room) surface to the user and stop auto-rejoin.
    if (msg.silent) {
      console.warn(`[RVS] ${msg.message}`);
    } else {
      clearActiveRoom();
      alert(`[Sync Error] ${msg.message}`);
    }
    return;
  }

  // No video integration off YouTube/Netflix — nothing to apply the command to.
  if (!player) return;

  // Ignore remote playback commands while the peer is on a different video.
  if (isDifferentVideoFromPeer()) return;

  player.apply(msg);
}

// YouTube/Netflix only — everything that touches the <video> element, the
// write-path player, or site-specific metadata lives here. Connecting to a
// room and answering GET_STATUS work regardless of hostname (see above and
// the popup message handler below).
function initVideoIntegration() {

// Site adapter — the only YouTube/Netflix difference on the READ/metadata
// side. Picked once so the rest of this function is site-agnostic.
function createSiteAdapter() {
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
const site = createSiteAdapter();

/** @type {HTMLVideoElement | null} */
let videoElement = null;
let isReadEventListenersBound = false;

// The write path is fully encapsulated per site (see players.js): YouTube
// writes the <video> directly; Netflix drives the official player API
// through the main-world bridge (direct writes there trigger error M7375).
player = isNetflix
  ? window.RVS.createBridgePlayer()
  : window.RVS.createDirectPlayer({ getVideo: getBoundVideo });

// Best-effort local media, or null when not on a watch page. Falls back to the URL.
function getLocalMedia() {
  if (!site.isWatchPage()) return null;
  const url = location.href;
  const title = site.getTitle();
  return { title: title || url, url };
}

/** @param {HTMLVideoElement} video */
function bindVideoReadEvents(video) {
  if (isReadEventListenersBound) return;

  console.log('[RVS] Video element found, listeners attached.');

  // Don't broadcast local actions while the player is applying a remote
  // command (anti-feedback) or while the peer is watching a different video.
  const shouldSkipReadBroadcast = () => player.isApplying() || isDifferentVideoFromPeer();

  video.addEventListener('play', () => {
    if (shouldSkipReadBroadcast()) return;
    backgroundPort.send({ action: 'play', time: video.currentTime });
  });

  video.addEventListener('pause', () => {
    if (shouldSkipReadBroadcast()) return;
    backgroundPort.send({ action: 'pause', time: video.currentTime });
  });

  video.addEventListener('seeked', () => {
    if (shouldSkipReadBroadcast()) return;
    backgroundPort.send({ action: 'seek', time: video.currentTime });
  });

  video.addEventListener('ratechange', () => {
    if (shouldSkipReadBroadcast()) return;
    backgroundPort.send({ action: 'rate', rate: video.playbackRate });
  });

  isReadEventListenersBound = true;
}

function findAndBindVideo() {
  const video = document.querySelector('video');
  if (!video) return;

  videoElement = video;
  bindVideoReadEvents(video);

  // A new <video> usually means the SPA navigated to a different title — share it.
  shareMediaInfo(false);

  // Drain a command the player parked while waiting for the element (direct
  // path; no-op on Netflix, which never parks).
  player.onVideoReady();
}

// Rebind when the SPA adds OR swaps the <video> element. Netflix replaces the
// element on an episode change; staying bound to the old (detached) one left
// READ listeners firing on a dead element, so local actions stopped
// broadcasting. Resets isReadEventListenersBound alongside videoElement, or
// bindVideoReadEvents() would see stale listeners as already attached and
// skip rebinding them to the new element.
function rebindVideo() {
  isReadEventListenersBound = false;
  videoElement = null;
  findAndBindVideo();
}

// Backs the direct (YouTube) player: returns the bound <video>, re-finding it
// if the SPA swapped the element out, or null if none exists yet. Injected
// into createDirectPlayer so the player file has no implicit dependency on
// this state.
function getBoundVideo() {
  if (videoElement && !videoElement.isConnected) {
    rebindVideo();
  }
  return videoElement || document.querySelector('video');
}

// shareMediaInfo must be assigned before findAndBindVideo() below — it can
// call shareMediaInfo synchronously the moment the <video> is already present.
shareMediaInfo = function (force) {
  const { status, peersCount } = connectionState.getSnapshot();
  if (status !== 'Connected' || peersCount !== 2) return;
  const media = getLocalMedia();
  if (!media) return;
  // De-dupe on title *and* url, not url alone: on a Netflix episode change the
  // new title isn't in the DOM yet when we first fire (getTitle() falls back
  // to "Netflix"), so keying on url alone would latch that stale title until
  // the next navigation. The periodic re-share below corrects it once the
  // real title settles (same url, changed title).
  const isUnchanged = lastSentMediaInfo
    && lastSentMediaInfo.url === media.url
    && lastSentMediaInfo.title === media.title;
  if (!force && isUnchanged) return;
  lastSentMediaInfo = media;
  backgroundPort.send({ action: 'media_info', title: media.title, url: media.url });
};

// Re-share periodically so the peer follows SPA route changes that reuse the
// same <video>, and titles that settle a beat after the URL.
setInterval(() => shareMediaInfo(false), 4000);

// The SPA injects/replaces the <video> ~1-2s after load, so we observe the
// DOM rather than assume it's present yet. Reads stay on the <video> element
// on both sites — only writes go through the bridge on Netflix.
findAndBindVideo();

const videoObserver = new MutationObserver(() => {
  const current = document.querySelector('video');
  if (current && current !== videoElement) {
    rebindVideo();
  }
});
videoObserver.observe(document.documentElement, { childList: true, subtree: true });

}

// Opened on every page, not just YouTube/Netflix, so a room can be
// joined/left/queried from any tab. Registered immediately, before any of
// the (possibly slow) DOM/observer setup in initVideoIntegration() below —
// so the status sync background sends the moment a connection goes live
// can't be missed.
const backgroundPort = window.RVS.createBackgroundPort({
  onMessage: handlePortMessage,

  // Resumes an active room on every successful connect — the first one and
  // every reconnect alike look identical from here: no live port, and
  // sessionStorage says which room (if any) this tab should be in.
  onConnect: (send) => {
    const resumeRoom = getActiveRoom();
    if (resumeRoom) {
      connectionState.connect();
      send({ action: 'CONNECT', roomId: resumeRoom });
    }
  },
});

console.log('[RVS] Content script injected.');

if (isYouTube || isNetflix) initVideoIntegration();

// Popup messages (CONNECT/DISCONNECT/GET_STATUS) — always registered so a
// room can be joined/left/queried from any tab, not just YouTube/Netflix.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'CONNECT') {
    connectionState.connect();
    lastSentMediaInfo = null;
    setActiveRoom(msg.roomId); // remember the session so it survives navigation
    setPrefilledRoom(msg.roomId); // keep the popup's suggestion in sync with the room in use
    backgroundPort.send({ action: 'CONNECT', roomId: msg.roomId });
    sendResponse({ success: true });
    return;
  }

  if (msg.action === 'DISCONNECT') {
    clearActiveRoom(); // explicit disconnect: don't auto-rejoin on reload
    backgroundPort.send({ action: 'DISCONNECT' });
    connectionState.disconnect();
    lastSentMediaInfo = null;
    sendResponse({ success: true });
    return;
  }

  if (msg.action === 'GET_STATUS') {
    // Seed a stable per-tab Room ID once, so reopening the popup shows the
    // same suggested ID instead of generating a new one each time.
    if (!isRoomPrefilled()) setPrefilledRoom(window.RVS.generateRoomId());
    const snapshot = connectionState.getSnapshot();
    sendResponse({
      status: snapshot.status,
      peersCount: snapshot.peersCount,
      latency: snapshot.latency,
      peerMediaInfo: snapshot.peerMediaInfo,
      roomId: getEffectiveRoomId(),
    });
  }
});
