// Injected on <all_urls> (see manifest — no host_permissions, so the corporate
// sandbox/DLP policies that block explicit youtube.com/netflix.com host grants
// don't stop the script from loading at all). CONNECT/DISCONNECT/GET_STATUS
// work on any page, so a room can be joined and its status queried before ever
// navigating to YouTube/Netflix. The hostname check (see shared-utils.js) only
// gates the video-specific integration (site adapter, player, DOM observer) in
// main().
const hostname = window.location.hostname;
const isNetflix = window.RVS.isHost(hostname, 'netflix.com');
const isYouTube = window.RVS.isHost(hostname, 'youtube.com') || window.RVS.isHost(hostname, 'youtu.be');

// ----------------------------------------------------------------------------
// 1. Connection state — mirrored from background purely to answer the popup's
//    GET_STATUS. The anti-feedback lock and command sequencing live inside the
//    active player (players.js), not here. See connection-state.js — status,
//    peer count, latency, and the peer's media are all private inside it;
//    content.js only calls its methods, never reaches into that state
//    directly.
// ----------------------------------------------------------------------------
const connectionState = window.RVS.createConnectionState();

// "Now Watching" sharing: the last { url, title } we shared (so we only
// re-broadcast when either actually changes). Not part of connectionState —
// this is content.js's own broadcast-dedup cache, unrelated to connection
// status itself, even though it's reset alongside it below.
let lastSentMediaInfo = null;

// The write-path player adapter (players.js) and the media-sharing broadcaster
// are only created on YouTube/Netflix (see main() below) — left null/unset
// elsewhere so the message handlers below can skip video-specific work
// off-site instead of erroring.
let player = null;
let shareMediaInfo = null;

// ----------------------------------------------------------------------------
// 2. Per-tab active room, persisted in sessionStorage so a full-page navigation
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

// The room ID the popup should show for this tab: the active (connected)
// room wins over the prefilled suggestion. Named so a caller that just wants
// "the room to display" doesn't need to independently know both keys exist
// or their precedence.
function getEffectiveRoomId() {
  return getActiveRoom() || getPrefilledRoom();
}

// ----------------------------------------------------------------------------
// 3. Port to background service worker. See background-port.js — connecting,
//    reconnecting after a bfcache restore or service-worker restart, and
//    sending safely are all its job; opened on every page (not just
//    YouTube/Netflix) so a room can be joined/left and queried from any tab.
//    content.js only supplies what a message means (handlePortMessage below)
//    and what to do once a connection is live (the onConnect callback).
// ----------------------------------------------------------------------------

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
    // origin) — persist its roomId here too, so this origin's sessionStorage
    // is correct even after a cross-origin navigation started it out empty.
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
    // The peer's current video. Stored for the popup to render; the URL is
    // validated there before it's turned into a clickable link.
    connectionState.handleMediaInfo({ title: msg.title, url: msg.url });
    return;
  }

  if (action === 'error') {
    connectionState.handleError();
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

  // No video integration off YouTube/Netflix — nothing to apply the command to.
  if (!player) return;

  // Ignore remote playback commands while the peer is on a different video.
  // peerMediaInfo is kept current by the media_info handler above.
  if (isDifferentVideoFromPeer()) return;

  // Sync command — the active player applies it (and parks/retries internally
  // on the direct path if the <video> isn't ready yet).
  player.apply(msg);
}

// Registered immediately, before any of the (possibly slow) DOM/observer
// setup in main() below, so a status sync background sends the instant a
// connection is live (see background.js's onConnect rebind path) is never
// missed.
const backgroundPort = window.RVS.createBackgroundPort({
  onMessage: handlePortMessage,

  // Resumes an active room on every successful connect — the very first one
  // and every reconnect alike, since from here the two look identical: no
  // live port, and sessionStorage says which room (if any) this tab should
  // be in.
  onConnect: (send) => {
    const resumeRoom = getActiveRoom();
    if (resumeRoom) {
      connectionState.connect();
      send({ action: 'CONNECT', roomId: resumeRoom });
    }
  },
});

console.log('[RVS] Content script injected.');

// ----------------------------------------------------------------------------
// 4. Canonical video identity + "different video" check. Only touches
//    connectionState's peerMediaInfo snapshot and location.href (not the site
//    adapter or player), so it's safe to keep unconditional; used below to
//    gate sync-command dispatch.
// ----------------------------------------------------------------------------
function getVideoId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    // Reuses window.RVS.isHost() (shared-utils.js) rather than a loose
    // substring/no-op check — this runs on peerMediaInfo.url too, which
    // arrives over the network from the peer, not just our own location.href.
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

// True only when we can confirm the peer is on a *different* video. Unknown
// (no peer media yet, or an unparseable URL) returns false, so sync isn't blocked
// during the brief post-pairing handshake or on unrecognized URLs.
function isDifferentVideoFromPeer() {
  const { peerMediaInfo } = connectionState.getSnapshot();
  if (!peerMediaInfo || !peerMediaInfo.url) return false;
  const local = getVideoId(location.href);
  const peer = getVideoId(peerMediaInfo.url);
  if (!local || !peer) return false;
  return local !== peer;
}

// ----------------------------------------------------------------------------
// 5. Video/player integration — YouTube/Netflix only. Everything that touches
//    the <video> element, the write-path player, or site-specific metadata is
//    scoped here; connecting to a room and answering GET_STATUS work regardless
//    of hostname (see above and the popup message handler below).
// ----------------------------------------------------------------------------
if (isYouTube || isNetflix) {
  main();
}

function main() {

// Site adapter — the only YouTube/Netflix difference on the READ/metadata side.
// Picked once, here, so the rest of this function is site-agnostic.
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

let videoElement = null;
let isReadEventListenersBound = false;

// The write path is fully encapsulated per site (see players.js): YouTube writes
// the <video> directly; Netflix drives the official player API through the
// main-world bridge (direct writes there trigger error M7375). Only the direct
// player needs to reach the bound <video>, so we inject getBoundVideo() into it.
player = isNetflix
  ? window.RVS.createBridgePlayer()
  : window.RVS.createDirectPlayer({ getVideo: getBoundVideo });

// ----------------------------------------------------------------------------
// "Now Watching" — share the current video's title + URL with the peer so each
// user can see (and open) what the other is browsing. Assigned to the
// outer-scope shareMediaInfo (a function expression, not hoisted) before the
// READ path below, since findAndBindVideo() can call it synchronously the
// moment main() runs if the <video> element is already present.
// ----------------------------------------------------------------------------

// Best-effort local media, or null when not on a watch page. Falls back to the URL.
function getLocalMedia() {
  if (!site.isWatchPage()) return null;
  const url = location.href;
  const title = site.getTitle();
  return { title: title || url, url };
}

// Broadcast the local video to the peer. Guarded so we only emit when paired;
// the background also drops media_info unless two peers are present. Pass
// force=true to re-send even if nothing changed (e.g. just after pairing).
shareMediaInfo = function (force) {
  const { status, peersCount } = connectionState.getSnapshot();
  if (status !== 'Connected' || peersCount !== 2) return;
  const media = getLocalMedia();
  if (!media) return;
  // De-dupe on title *and* url, not url alone: on a Netflix episode change the new
  // title isn't in the DOM yet when we first fire (getTitle() falls back to
  // "Netflix"), so keying on url alone would latch that stale title until the next
  // navigation. Comparing both fields, the periodic re-share below corrects it
  // once the real title settles (same url, changed title).
  const isUnchanged = lastSentMediaInfo
    && lastSentMediaInfo.url === media.url
    && lastSentMediaInfo.title === media.title;
  if (!force && isUnchanged) return;
  lastSentMediaInfo = media;
  backgroundPort.send({ action: 'media_info', title: media.title, url: media.url });
};

// Periodically re-share the local video so the peer follows navigation to a new
// title (covers SPA route changes that reuse the same <video>, and titles that
// settle a beat after the URL). Self-guards on connection state, and only emits
// when the title/url actually changed.
setInterval(() => shareMediaInfo(false), 4000);

// ----------------------------------------------------------------------------
// READ path — discover the <video> and capture local user actions.
// The SPA injects/replaces the element ~1-2s after load, so we observe the DOM.
// On Netflix this path is still active (reads are unchanged); only writes go
// through the bridge. The <video> here is effectively read-only on Netflix.
// ----------------------------------------------------------------------------
findAndBindVideo();

// Rebind when the SPA adds OR swaps the <video> element. Netflix replaces the
// element on an episode change; staying bound to the old (now-detached) one left
// our READ listeners firing on a dead element, so local actions stopped being
// broadcast. (Writes are unaffected — the bridge / direct path re-look-up the
// element.) Re-finding here also re-shares media_info for the new episode.
const videoObserver = new MutationObserver(() => {
  const current = document.querySelector('video');
  if (current && current !== videoElement) {
    rebindVideo();
  }
});
videoObserver.observe(document.documentElement, { childList: true, subtree: true });

// Reset video-binding state and re-discover the <video> — shared by the
// MutationObserver above (the SPA swapped the element) and getBoundVideo()
// below (the bound element was detached from the DOM). Both need to reset
// isReadEventListenersBound alongside videoElement, or bindVideoReadEvents()
// would see listeners as already attached (to a now-dead element) and skip
// rebinding them to the new one.
function rebindVideo() {
  isReadEventListenersBound = false;
  videoElement = null;
  findAndBindVideo();
}

function findAndBindVideo() {
  const video = document.querySelector('video');
  if (!video) return;

  videoElement = video;
  bindVideoReadEvents(video);

  // A new <video> usually means the SPA navigated to a different title — share it.
  shareMediaInfo(false);

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

// Backs the direct (YouTube) player: returns the bound <video>, re-finding it if
// the SPA swapped the element out, or null if none exists yet. Injected into
// createDirectPlayer so the player file has no implicit dependency on this state.
function getBoundVideo() {
  if (videoElement && !videoElement.isConnected) {
    rebindVideo();
  }
  return videoElement || document.querySelector('video');
}

}

// ----------------------------------------------------------------------------
// 6. Popup messages (CONNECT / DISCONNECT / GET_STATUS) — always registered, so
//    a room can be joined/left/queried from any tab, not just YouTube/Netflix.
// ----------------------------------------------------------------------------
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
    // Seed a stable per-tab Room ID once, so reopening the popup shows the same
    // suggested ID instead of generating a new one each time.
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
