importScripts('config.js');

// tabId → { port, socket, roomId, status, peersCount, oneWayLatency, pingInterval }
const tabStates = new Map();

// Content scripts connect here; the open port keeps the service worker alive.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'rvs-sync') return;

  const tabId = port.sender.tab.id;
  const state = {
    port,
    socket: null,
    roomId: null,
    status: 'Disconnected',
    peersCount: 0,
    oneWayLatency: 0,
    pingInterval: null,
  };
  tabStates.set(tabId, state);

  port.onMessage.addListener((msg) => handlePortMessage(tabId, state, msg));
  port.onDisconnect.addListener(() => {
    cleanupSocket(tabId, state);
    tabStates.delete(tabId);
  });
});

function handlePortMessage(tabId, state, msg) {
  if (msg.action === 'CONNECT') {
    openWebSocket(tabId, state, msg.roomId);
    return;
  }

  if (msg.action === 'DISCONNECT') {
    cleanupSocket(tabId, state);
    return;
  }

  // Forward video events (play/pause/seek/rate) to server
  if (state.socket && state.socket.readyState === WebSocket.OPEN && state.peersCount === 2) {
    state.socket.send(JSON.stringify(msg));
  }
}

function openWebSocket(tabId, state, roomId) {
  if (state.socket) {
    // Detach handlers before closing so the old socket's async onclose/onerror
    // can't fire cleanupSocket() and tear down the new socket we're about to open.
    const old = state.socket;
    old.onopen = old.onmessage = old.onclose = old.onerror = null;
    old.close();
  }

  state.roomId = roomId;
  state.status = 'Connecting';
  updateIcon(tabId, 'Connecting');

  const socket = new WebSocket(WS_SERVER_URL);
  state.socket = socket;

  socket.onopen = () => {
    socket.send(JSON.stringify({ action: 'join', room: roomId }));
  };

  socket.onmessage = (event) => handleServerMessage(tabId, state, event.data);

  socket.onclose = () => cleanupSocket(tabId, state);

  socket.onerror = () => {
    // Connection-level failure (server down / unreachable). Mark silent so the
    // content script drops cleanly to Disconnected instead of alerting.
    send(state, { action: 'error', message: 'Signaling server unavailable', silent: true });
    cleanupSocket(tabId, state);
  };
}

function handleServerMessage(tabId, state, rawMessage) {
  try {
    const data = JSON.parse(rawMessage);
    const { action } = data;

    if (action === 'error') {
      send(state, data);
      cleanupSocket(tabId, state);
      return;
    }

    if (action === 'state') {
      state.peersCount = data.peersCount || 0;

      if (data.status === 'connected') {
        state.status = 'Connected';
        updateIcon(tabId, 'Connected');
        if (state.peersCount === 2) startLatencyPings(tabId, state);
      } else if (data.status === 'peer_disconnected') {
        state.peersCount = 1;
        stopLatencyPings(state);
      }

      send(state, data);
      return;
    }

    if (action === 'p2p_ping') {
      if (state.socket && state.socket.readyState === WebSocket.OPEN) {
        state.socket.send(JSON.stringify({ action: 'p2p_pong', timestamp: data.timestamp }));
      }
      return;
    }

    if (action === 'p2p_pong') {
      const rtt = Date.now() - data.timestamp;
      state.oneWayLatency = rtt / 2;
      send(state, { action: 'latency_update', latency: state.oneWayLatency });
      return;
    }

    // Forward sync commands (play/pause/seek/rate) to the content script
    send(state, data);

  } catch (err) {
    console.error('[RVS] Error handling server message:', err);
  }
}

function startLatencyPings(tabId, state) {
  stopLatencyPings(state);
  state.pingInterval = setInterval(() => {
    if (state.socket && state.socket.readyState === WebSocket.OPEN && state.peersCount === 2) {
      state.socket.send(JSON.stringify({ action: 'p2p_ping', timestamp: Date.now() }));
    }
  }, 5000);
}

function stopLatencyPings(state) {
  if (state.pingInterval) {
    clearInterval(state.pingInterval);
    state.pingInterval = null;
  }
  state.oneWayLatency = 0;
}

function cleanupSocket(tabId, state) {
  stopLatencyPings(state);
  if (state.socket) {
    state.socket.close();
    state.socket = null;
  }
  state.status = 'Disconnected';
  state.peersCount = 0;
  state.roomId = null;
  updateIcon(tabId, 'Disconnected');
}

// Safe postMessage — port may already be disconnected
function send(state, msg) {
  try {
    state.port.postMessage(msg);
  } catch (_) {}
}

// Reset icon when tab navigates or reloads
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    updateIcon(tabId, 'Disconnected');
  }
});

function updateIcon(tabId, status) {
  let color = '#ff5252';
  if (status === 'Connecting') color = '#ffb300';
  else if (status === 'Connected') color = '#00e676';

  const canvas = new OffscreenCanvas(32, 32);
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, 32, 32);

  ctx.beginPath();
  ctx.arc(16, 16, 14, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(16, 16, 14, 0, 2 * Math.PI);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(13, 11);
  ctx.lineTo(13, 21);
  ctx.lineTo(21, 16);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  const imageData = ctx.getImageData(0, 0, 32, 32);
  chrome.action.setIcon({ tabId, imageData }, () => {
    // Access lastError to clear Chrome's "Unchecked runtime.lastError" warning
    // (setIcon can fail benignly, e.g. the tab closed before this ran).
    void chrome.runtime.lastError;
  });
}
