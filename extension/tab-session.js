/**
 * @fileoverview One tab's connection lifecycle: the WebSocket to the
 * signaling server, the port to that tab's content script, and the
 * room-membership/latency-ping state. Loaded into background.js via
 * importScripts (like config.js), so createTabSession() is a plain
 * global in that shared scope — no window.RVS needed, since a service
 * worker doesn't share scope with any page script.
 */
/* exported createTabSession */

// Fragile, undocumented dependency on Chrome's exact disconnect-reason
// wording — isolated here (rather than an inline regex inside disconnect())
// so it's independently testable and easy to update if Chrome ever changes
// the wording.
/** @param {string | undefined} reason */
function isBfcacheDisconnectReason(reason) {
  return /back\/forward cache/.test(reason || '');
}

// Creates the session for one tabId. `updateIcon` is injected (matching
// createDirectPlayer's `{ getVideo }` convention) rather than called as a
// bare global — every other external dependency here is already an
// explicit parameter or return value.
//
// Public interface is rebind/disconnect/handlePortMessage/getStatus;
// background.js's onConnect/onDisconnect handlers are thin dispatchers into
// this and never touch the WebSocket, port, or state directly. Everything
// below is declared in dependency order down to that interface.
/**
 * @param {number} tabId
 * @param {{ updateIcon: (tabId: number, status: string) => void }} deps
 * @returns {TabSession}
 */
function createTabSession(tabId, { updateIcon }) {
  /** @type {chrome.runtime.Port | null} */
  let port = null;
  /** @type {WebSocket | null} */
  let socket = null;
  /** @type {string | null} */
  let roomId = null;
  let status = 'Disconnected';
  let peersCount = 0;
  let oneWayLatency = 0;
  /** @type {ReturnType<typeof setInterval> | null} */
  let pingInterval = null;
  // Set by requestPeerSync() when it can't send immediately (the socket for
  // a freshly (re)created session isn't open yet at rebind time — it only
  // opens once handlePortMessage's CONNECT arrives, which is asynchronous
  // relative to rebind()). Consumed the moment handleServerMessage's own
  // 'state'/'connected'+2-peers confirmation arrives, since that's the
  // first point a send is actually guaranteed to succeed.
  let pendingPeerSyncRequest = false;

  // The WebSocket lifecycle and latency-ping loop aren't independent
  // (cleanupSocket stops pings; handleServerMessage starts/stops them),
  // so they're interleaved by dependency order rather than grouped.

  // Safe postMessage — port may already be disconnected. Deliberately
  // untyped (`any`), matching handlePortMessage below: the packet shape
  // varies (relayed server messages, synthesized latency_update, etc.),
  // validated at the receiving end rather than statically discriminated.
  /** @param {any} msg */
  function sendToPort(msg) {
    if (!port) {
      return;
    }
    // port may disconnect between the check above and this call — the
    // onDisconnect listener handles cleanup separately, nothing to do here.
    try { port.postMessage(msg); } catch (_) {}
  }

  function stopLatencyPings() {
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
    oneWayLatency = 0;
  }

  function startLatencyPings() {
    stopLatencyPings();
    pingInterval = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN && peersCount === 2) {
        socket.send(JSON.stringify({ action: 'p2p_ping', timestamp: Date.now() }));
      }
    }, 5000);
  }

  function cleanupSocket() {
    stopLatencyPings();
    if (socket) {
      socket.close();
      socket = null;
    }
    status = 'Disconnected';
    peersCount = 0;
    roomId = null;
    updateIcon(tabId, 'Disconnected');
  }

  /** @param {string} rawMessage */
  function handleServerMessage(rawMessage) {
    try {
      const msg = JSON.parse(rawMessage);
      const { action } = msg;

      if (action === 'error') {
        console.log(`[RVS] tab=${tabId} server error: ${msg.message}`);
        sendToPort(msg);
        cleanupSocket();
        return;
      }

      if (action === 'state') {
        peersCount = msg.peersCount || 0;

        if (msg.status === 'connected') {
          status = 'Connected';
          updateIcon(tabId, 'Connected');
          if (peersCount === 2) {
            startLatencyPings();
            if (pendingPeerSyncRequest) {
              pendingPeerSyncRequest = false;
              console.log(`[RVS] tab=${tabId} sending deferred request_sync now that peersCount=2`);
              socket.send(JSON.stringify({ action: 'request_sync' }));
            }
          }
        } else if (msg.status === 'peer_disconnected') {
          peersCount = 1;
          stopLatencyPings();
        }

        // Enrich with the roomId this session tracks — the server's own
        // 'state' message doesn't include it, and content.js persists it as
        // the origin-independent source of truth for this tab's active room.
        sendToPort({ ...msg, roomId });
        return;
      }

      if (action === 'p2p_ping') {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ action: 'p2p_pong', timestamp: msg.timestamp }));
        }
        return;
      }

      if (action === 'p2p_pong') {
        const rtt = Date.now() - msg.timestamp;
        oneWayLatency = rtt / 2;
        sendToPort({ action: 'latency_update', latency: oneWayLatency });
        return;
      }

      // Forward sync commands (play/pause/seek/rate) to the content script,
      // stamping latency compensation here (where it's measured) so the
      // content script applies times verbatim. One-way latency ≈ RTT/2;
      // play/seek target a slightly later position to align despite delay.
      if ((action === 'play' || action === 'seek') && typeof msg.time === 'number') {
        msg.time += oneWayLatency / 1000;
      }
      console.log(`[RVS] tab=${tabId} handleServerMessage forwarding to port action=${action} hasPort=${!!port}`);
      sendToPort(msg);

    } catch (err) {
      console.error('[RVS] Error handling server message:', err);
    }
  }

  /** @param {string} newRoomId */
  function openWebSocket(newRoomId) {
    // Already connected/connecting to this room — happens when a rebound
    // port's content script resends its routine resumeRoom CONNECT (see
    // rebind() below). Reopening here would recreate the exact race
    // rebind() exists to avoid.
    if (socket && roomId === newRoomId && (status === 'Connected' || status === 'Connecting')) {
      console.log(`[RVS] tab=${tabId} openWebSocket SKIPPED (already ${status} to room ${newRoomId})`);
      return;
    }
    console.log(`[RVS] tab=${tabId} openWebSocket OPENING fresh socket for room ${newRoomId} (previous status=${status}, previous roomId=${roomId})`);

    if (socket) {
      // Detach handlers before closing so the old socket's async
      // onclose/onerror can't fire cleanupSocket() and tear down the new
      // socket we're about to open.
      const old = socket;
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      old.close();
    }

    roomId = newRoomId;
    status = 'Connecting';
    updateIcon(tabId, 'Connecting');

    socket = new WebSocket(WS_SERVER_URL);

    socket.onopen = () => {
      socket.send(JSON.stringify({ action: 'join', room: newRoomId }));
    };

    socket.onmessage = (event) => handleServerMessage(event.data);

    socket.onclose = () => cleanupSocket();

    socket.onerror = () => {
      // Connection-level failure (server down / unreachable). Mark silent so
      // the content script drops cleanly to Disconnected instead of alerting.
      sendToPort({ action: 'error', message: 'Signaling server unavailable', silent: true });
      cleanupSocket();
    };
  }

  // ----------------------------------------------------------------------------
  // Public interface
  // ----------------------------------------------------------------------------

  // Attach a new port to this session — either the tab's first-ever
  // connection, or a reload/bfcache-eviction reusing a still-alive session.
  // Pushes an immediate status sync if already connected, since a fresh
  // content script otherwise defaults to "Connecting" until the next
  // (possibly long-delayed) server message corrects it.
  /** @param {chrome.runtime.Port} newPort */
  function rebind(newPort) {
    const isRebind = port !== null;
    console.log(`[RVS] tab=${tabId} onConnect rebind=${isRebind} status=${status} roomId=${roomId}`);
    port = newPort;
    if (status === 'Connected') {
      sendToPort({ action: 'state', status: 'connected', peersCount, roomId });
      if (oneWayLatency) {
        sendToPort({ action: 'latency_update', latency: oneWayLatency });
      }
    }
  }

  // Called from port.onDisconnect. `deadPort` is the port that disconnected
  // (may be stale if a rebind already replaced it); `lastErrorMessage` is
  // chrome.runtime.lastError.message read at the call site (this module
  // never touches chrome.* directly). Returns true if the session is
  // actually gone (caller should delete it); false means a port will
  // rebind onto it later.
  /**
   * @param {chrome.runtime.Port} deadPort
   * @param {string | undefined} lastErrorMessage
   */
  function disconnect(deadPort, lastErrorMessage) {
    const isStale = port !== deadPort;

    // Chrome disconnects a port the instant its page becomes bfcache-eligible
    // — on essentially any navigation, well before the new content script
    // starts loading. That's not "this tab is gone" (the page may still be
    // alive, just frozen), so tearing the session down here would beat
    // rebind() to it: the new port would connect to a deleted session and
    // reopen the WebSocket from scratch, recreating the exact race this
    // module exists to avoid.
    const isBfcache = !isStale && isBfcacheDisconnectReason(lastErrorMessage);

    console.log(`[RVS] tab=${tabId} disconnect stale=${isStale} bfcache=${isBfcache} status=${status} roomId=${roomId}`);

    if (isStale || isBfcache) {
      return false;
    }

    cleanupSocket();
    return true;
  }

  // Deliberately untyped (`any`), matching sendToPort above: the packet
  // shape varies (CONNECT/DISCONNECT from the popup, sync commands),
  // validated below via the action field rather than statically
  // discriminated.
  /** @param {any} msg */
  function handlePortMessage(msg) {
    if (msg.action === 'CONNECT') {
      openWebSocket(msg.roomId);
      return;
    }

    if (msg.action === 'DISCONNECT') {
      cleanupSocket();
      return;
    }

    // Forward video events (play/pause/seek/rate) to server
    const canForward = !!(socket && socket.readyState === WebSocket.OPEN && peersCount === 2);
    console.log(`[RVS] tab=${tabId} handlePortMessage forwarding action=${msg.action} canForward=${canForward} peersCount=${peersCount}`);
    if (canForward) {
      socket.send(JSON.stringify(msg));
    }
  }

  function getStatus() {
    return status;
  }

  // Backs Join Peer's "different video" branch (see CLAUDE.md): called by
  // background.js right after rebind(), for a port whose content.js sent
  // JOIN_PEER_PENDING before navigating. Deliberately a public method
  // rather than a message this session tracks itself — background.js's
  // pendingPeerSyncTabIds Set is what actually survives the navigation
  // (this session's own in-memory state does not: a real, non-bfcache
  // disconnect tears it down and a fresh session gets created in its
  // place, same as any other in-memory field here would be lost too).
  //
  // A freshly (re)created session has no socket yet at this exact point —
  // openWebSocket() only runs once handlePortMessage's CONNECT arrives,
  // which is a separate, later message than the rebind this is called
  // from. So this can't just check-and-send once: if the socket isn't
  // ready, it defers to pendingPeerSyncRequest above instead of dropping
  // the request on the floor.
  function requestPeerSync() {
    const canSend = !!(socket && socket.readyState === WebSocket.OPEN && peersCount === 2);
    console.log(`[RVS] tab=${tabId} requestPeerSync canSend=${canSend} socketState=${socket && socket.readyState} peersCount=${peersCount}`);
    if (canSend) {
      socket.send(JSON.stringify({ action: 'request_sync' }));
    } else {
      pendingPeerSyncRequest = true;
    }
  }

  return { rebind, disconnect, handlePortMessage, requestPeerSync, getStatus };
}
