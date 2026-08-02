// tab-session.js — one tab's connection lifecycle: the WebSocket to the
// signaling server, the port to that tab's content script, and the
// room-membership/latency-ping state. Loaded into background.js via
// importScripts (same convention as config.js), so createTabSession() is a
// plain global in that shared scope — no window.RVS namespace needed here,
// since a service worker isn't sharing this scope with any page script the
// way content scripts do.
/* exported createTabSession */

// Fragile, undocumented dependency on Chrome's exact disconnect-reason
// wording — isolated here so it's independently nameable (and testable
// against fixed fixture strings) rather than an inline regex buried inside
// createTabSession()'s disconnect(). If Chrome ever changes this wording,
// this is the one place that needs updating.
function isBfcacheDisconnectReason(message) {
  return /back\/forward cache/.test(message || '');
}

// Creates the session for one tabId. `updateIcon` is injected (matching
// createDirectPlayer's `{ getVideo }` convention in players.js) rather than
// called as a bare global from background.js's shared importScripts scope —
// every other external dependency here (chrome.runtime.lastError, the port
// itself) is already an explicit parameter or return value, not something
// this module reaches out and grabs.
//
// The whole public interface is rebind/disconnect/handlePortMessage/
// getStatus — background.js's chrome.runtime.onConnect/onDisconnect handlers
// become thin dispatchers into this, and never touch the WebSocket, the
// port, or any of this state directly. Everything below is declared in
// dependency order — each function only calls things already defined above
// it — down to the public interface at the bottom, which is the only part
// background.js ever touches.
function createTabSession(tabId, { updateIcon }) {
  let port = null;
  let socket = null;
  let roomId = null;
  let status = 'Disconnected';
  let peersCount = 0;
  let oneWayLatency = 0;
  let pingInterval = null;

  // The WebSocket lifecycle and the latency-ping loop below aren't
  // independent — cleanupSocket stops the pings, handleServerMessage starts
  // and stops them — which is why they're interleaved by dependency order
  // here rather than grouped under separate headers.

  // Safe postMessage — port may already be disconnected.
  function sendToPort(msg) {
    if (!port) return;
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

  function handleServerMessage(rawMessage) {
    try {
      const data = JSON.parse(rawMessage);
      const { action } = data;

      if (action === 'error') {
        console.log(`[RVS] tab=${tabId} server error: ${data.message}`);
        sendToPort(data);
        cleanupSocket();
        return;
      }

      if (action === 'state') {
        peersCount = data.peersCount || 0;

        if (data.status === 'connected') {
          status = 'Connected';
          updateIcon(tabId, 'Connected');
          if (peersCount === 2) startLatencyPings();
        } else if (data.status === 'peer_disconnected') {
          peersCount = 1;
          stopLatencyPings();
        }

        // Enrich with the roomId this session tracks — the server's own
        // 'state' message doesn't include it, and content.js persists it as
        // the origin-independent source of truth for this tab's active room.
        sendToPort({ ...data, roomId });
        return;
      }

      if (action === 'p2p_ping') {
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ action: 'p2p_pong', timestamp: data.timestamp }));
        }
        return;
      }

      if (action === 'p2p_pong') {
        const rtt = Date.now() - data.timestamp;
        oneWayLatency = rtt / 2;
        sendToPort({ action: 'latency_update', latency: oneWayLatency });
        return;
      }

      // Forward sync commands (play/pause/seek/rate) to the content script.
      // Stamp latency compensation here (where latency is measured) so the
      // content script applies times verbatim. One-way latency ≈ RTT/2;
      // play/seek aim at a slightly later position so playback aligns
      // despite transmission delay.
      if ((action === 'play' || action === 'seek') && typeof data.time === 'number') {
        data.time += oneWayLatency / 1000;
      }
      sendToPort(data);

    } catch (err) {
      console.error('[RVS] Error handling server message:', err);
    }
  }

  function openWebSocket(newRoomId) {
    // Already connected/connecting to this exact room — happens whenever a
    // rebound port's content script resends its routine resumeRoom CONNECT
    // (see rebind() below). Tearing down and reopening here would recreate
    // the exact race rebind() exists to avoid.
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
  // connection, or a same-tab reload/bfcache-eviction reusing a session
  // that's still alive. Pushes an immediate status sync if already
  // connected, since a freshly-injected content script otherwise defaults
  // to "Connecting" and would wait on the next server message to correct
  // itself — which may not arrive for a while if the room is quiet.
  function rebind(newPort) {
    const isRebind = port !== null;
    console.log(`[RVS] tab=${tabId} onConnect rebind=${isRebind} status=${status} roomId=${roomId}`);
    port = newPort;
    if (status === 'Connected') {
      sendToPort({ action: 'state', status: 'connected', peersCount, roomId });
      if (oneWayLatency) sendToPort({ action: 'latency_update', latency: oneWayLatency });
    }
  }

  // Called from port.onDisconnect. `deadPort` is the port that disconnected
  // (may be stale if a rebind already replaced it); `lastErrorMessage` is
  // chrome.runtime.lastError.message read at the call site — this module
  // never touches chrome.* APIs directly. Returns true when the session is
  // actually gone and the caller should delete it from tabStates; false
  // means "keep this session, a port will rebind onto it later."
  function disconnect(deadPort, lastErrorMessage) {
    const isStale = port !== deadPort;

    // Chrome disconnects a content script's port the instant its page
    // becomes eligible for the back/forward cache — which fires on
    // essentially any navigation, well before the new page's content script
    // even starts loading. That's not a real "this tab is gone" signal (the
    // page may still be alive, just frozen), so tearing the session down
    // here would race rebind() out of ever engaging: by the time the new
    // port connects, the session would already be deleted, reopening a
    // brand-new WebSocket and rejoining the room from scratch — recreating
    // the exact race this module exists to avoid.
    const isBfcache = !isStale && isBfcacheDisconnectReason(lastErrorMessage);

    console.log(`[RVS] tab=${tabId} disconnect stale=${isStale} bfcache=${isBfcache} status=${status} roomId=${roomId}`);

    if (isStale || isBfcache) return false;

    cleanupSocket();
    return true;
  }

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
    if (socket && socket.readyState === WebSocket.OPEN && peersCount === 2) {
      socket.send(JSON.stringify(msg));
    }
  }

  function getStatus() {
    return status;
  }

  return { rebind, disconnect, handlePortMessage, getStatus };
}
