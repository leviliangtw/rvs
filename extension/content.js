/**
 * @fileoverview Injected on <all_urls> (no host_permissions, so DLP/sandbox
 * policies can't block it). CONNECT/DISCONNECT/GET_STATUS work on any page;
 * isSyncSupported below gates whether Video Integration gets constructed.
 * IIFE-wrapped like the rest of the content-script bundle; loads last, so
 * it exports nothing via window.RVS.
 */
(() => {
  'use strict';

  const hostname = window.location.hostname;
  const isNetflix = window.RVS.isHost(hostname, 'netflix.com');
  const isYouTube = window.RVS.isHost(hostname, 'youtube.com') || window.RVS.isHost(hostname, 'youtu.be');
  const isSyncSupported = isYouTube || isNetflix;

  // Mirrored from background purely to answer the popup's GET_STATUS — see
  // connection-state.js for what it owns.
  const connectionState = window.RVS.createConnectionState();

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
    // sessionStorage can throw when disabled (e.g. some private-browsing
    // modes) — losing the reload-resume convenience is an acceptable
    // degradation, not worth surfacing.
    try { sessionStorage.setItem(ACTIVE_ROOM_KEY, roomId); } catch (_) {}
  }
  function clearActiveRoom() {
    // Same as setActiveRoom above — nothing to clear if storage is unavailable.
    try { sessionStorage.removeItem(ACTIVE_ROOM_KEY); } catch (_) {}
  }

  function getPrefilledRoom() {
    try { return sessionStorage.getItem(PREFILLED_ROOM_KEY); } catch (_) { return null; }
  }
  /** @param {string} roomId */
  function setPrefilledRoom(roomId) {
    // Same as setActiveRoom above.
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
        if (window.RVS.isHost(host, 'youtu.be')) {
          return `yt:${u.pathname.slice(1)}`;
        }
        if (u.pathname.startsWith('/shorts/')) {
          return `yt:${u.pathname.split('/')[2] || ''}`;
        }
        const v = u.searchParams.get('v');
        return v ? `yt:${v}` : null;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  // True only when we can confirm the peer is on a different video; unknown
  // cases (no peer media yet, unparseable URL) return false so sync isn't
  // blocked unnecessarily.
  function isDifferentVideoFromPeer() {
    const { peerMediaInfo } = connectionState.getSnapshot();
    if (!peerMediaInfo || !peerMediaInfo.url) {
      return false;
    }
    const local = getVideoId(location.href);
    const peer = getVideoId(peerMediaInfo.url);
    if (!local || !peer) {
      return false;
    }
    return local !== peer;
  }

  // Deliberately untyped (`any`): the packet shape varies by action
  // (state/error/media_info/sync commands), validated below via the
  // action field rather than statically discriminated. Matches
  // background-port.js and tab-session.js's same-shaped handlers.
  /** @param {any} msg */
  function handleBackgroundMessage(msg) {
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
      if (confirmedRoomId) {
        setActiveRoom(confirmedRoomId);
      }
      // Newly paired: tell the peer what we're watching right now (no-op off-site).
      if (isJustPaired && videoIntegration) {
        videoIntegration.shareMediaInfo(true);
      }
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
      // Connection-level failures (e.g. server unavailable) disconnect
      // silently so a reload can retry; actionable server errors (room
      // full, invalid room) surface to the user and stop auto-rejoin.
      if (msg.silent) {
        console.warn(`[RVS] ${msg.message}`);
      } else {
        clearActiveRoom();
        alert(`[Sync Error] ${msg.message}`);
      }
      return;
    }

    // Off YouTube/Netflix there's no Video Integration to apply the command
    // to. (Skipping commands while the peer is on a different video is
    // apply()'s own job now — see video-integration.js.)
    if (!videoIntegration) {
      return;
    }
    videoIntegration.apply(msg);
  }

  // Opened on every page, not just YouTube/Netflix, so a room can be
  // joined/left/queried from any tab. Registered before Video Integration
  // below, so the status sync sent the moment a connection goes live
  // can't be missed.
  const backgroundPort = window.RVS.createBackgroundPort({
    onMessage: handleBackgroundMessage,

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

  // video-integration.js is content.js's YouTube/Netflix-only half (the
  // <video> element, write-path player, "Now Watching" broadcaster). Only
  // constructed when isSyncSupported (ADR-0001: room connection stays
  // host-agnostic); content.js holds exactly this one nullable reference.
  /** @type {RvsVideoIntegration | null} */
  const videoIntegration = isSyncSupported
    ? window.RVS.createVideoIntegration({
        isNetflix,
        getSnapshot: connectionState.getSnapshot,
        send: backgroundPort.send,
        isDifferentVideoFromPeer,
      })
    : null;

  // Popup messages (CONNECT/DISCONNECT/GET_STATUS) — always registered so a
  // room can be joined/left/queried from any tab, not just YouTube/Netflix.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'CONNECT') {
      connectionState.connect();
      if (videoIntegration) {
        videoIntegration.forgetSharedMedia();
      }
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
      if (videoIntegration) {
        videoIntegration.forgetSharedMedia();
      }
      sendResponse({ success: true });
      return;
    }

    if (msg.action === 'GET_STATUS') {
      // Seed a stable per-tab Room ID once, so reopening the popup shows the
      // same suggested ID instead of generating a new one each time.
      if (!isRoomPrefilled()) {
        setPrefilledRoom(window.RVS.generateRoomId());
      }
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
})();
