// Global states
let socket = null;
let connectionStatus = 'Disconnected';
let peersCount = 0;
let oneWayLatency = 0; // in milliseconds
let ignoreSyncEvents = false;
let currentRoomId = null;
let pingInterval = null;

let videoElement = null;
let eventListenersBound = false;

console.log('[Sync] Remote Video Synchronizer (RVS) Extension content script injected.');

// Initialize video element discovery
findAndBindVideo();

// Keep searching for video element in case of dynamic SPA navigation (YouTube/Netflix page changes)
const searchInterval = setInterval(() => {
  if (!eventListenersBound) {
    findAndBindVideo();
  }
}, 2000);

// Find video element and bind sync events
function findAndBindVideo() {
  const video = document.querySelector('video');
  if (video) {
    videoElement = video;
    bindVideoEvents(video);
  }
}

function bindVideoEvents(video) {
  if (eventListenersBound) return;

  console.log('[Sync] Injected native video listeners successfully.');

  video.addEventListener('play', () => {
    if (ignoreSyncEvents) return;
    console.log('[Sync] Local play event captured at:', video.currentTime);
    sendSyncMessage({ action: 'play', time: video.currentTime });
  });

  video.addEventListener('pause', () => {
    if (ignoreSyncEvents) return;
    console.log('[Sync] Local pause event captured.');
    sendSyncMessage({ action: 'pause', time: video.currentTime });
  });

  video.addEventListener('seeked', () => {
    if (ignoreSyncEvents) return;
    console.log('[Sync] Local seek event captured. Current time:', video.currentTime);
    sendSyncMessage({ action: 'seek', time: video.currentTime });
  });

  video.addEventListener('ratechange', () => {
    if (ignoreSyncEvents) return;
    console.log('[Sync] Local playback rate changed to:', video.playbackRate);
    sendSyncMessage({ action: 'rate', rate: video.playbackRate });
  });

  eventListenersBound = true;
}

// Listen for messages from the popup panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, roomId } = message;

  if (action === 'CONNECT') {
    connectToSignalingServer(roomId)
      .then(() => {
        sendResponse({ success: true });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true; // Keep message channel open for async response
  }

  if (action === 'GET_STATUS') {
    sendResponse({
      status: connectionStatus,
      peersCount: peersCount,
      latency: peersCount === 2 ? oneWayLatency : null
    });
  }
});

// Establish WebSocket connection to the signaling server
function connectToSignalingServer(roomId) {
  return new Promise((resolve, reject) => {
    try {
      if (socket) {
        socket.close();
      }

      currentRoomId = roomId;
      connectionStatus = 'Connecting';
      console.log(`[Sync] Connecting to ${WS_SERVER_URL} for room ${roomId}...`);
      
      // Connect to WS signaling server (URL from config.js)
      socket = new WebSocket(WS_SERVER_URL);

      socket.onopen = () => {
        console.log('[Sync] Connected to signaling server. Joining room...');
        socket.send(JSON.stringify({ action: 'join', room: roomId }));
        resolve();
      };

      socket.onmessage = (event) => {
        handleWebSocketMessage(event.data);
      };

      socket.onclose = () => {
        console.log('[Sync] WebSocket connection closed.');
        cleanupConnection();
      };

      socket.onerror = (err) => {
        console.error('[Sync] WebSocket connection error:', err);
        connectionStatus = 'Disconnected';
        reject(new Error('Signaling server unavailable'));
      };

    } catch (e) {
      connectionStatus = 'Disconnected';
      reject(e);
    }
  });
}

// Handle real-time synchronization packets from signaling server
function handleWebSocketMessage(rawMessage) {
  try {
    const data = JSON.parse(rawMessage);
    const { action } = data;

    if (action === 'error') {
      alert(`[Sync Error] ${data.message}`); // Native alert for prototype simplicity
      cleanupConnection();
      return;
    }

    if (action === 'state') {
      const prevPeers = peersCount;
      peersCount = data.peersCount || 0;
      
      if (data.status === 'connected') {
        connectionStatus = 'Connected';
        console.log(`[Sync] Room state updated. Peers in room: ${peersCount}`);
        
        if (peersCount === 2) {
          startLatencyPings();
        }
      } else if (data.status === 'peer_disconnected') {
        alert('Remote user has disconnected.'); // Native alert for prototype simplicity
        peersCount = 1;
        stopLatencyPings();
      }
      return;
    }

    // Locate video element dynamically to ensure fresh DOM references
    const video = document.querySelector('video');
    if (!video) {
      console.warn('[Sync] Received sync command, but no active video element found.');
      return;
    }

    // Set lock flag to ignore programmatic event reflections
    ignoreSyncEvents = true;

    if (action === 'p2p_ping') {
      // Respond instantly with a p2p_pong packet containing the ping timestamp
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ action: 'p2p_pong', timestamp: data.timestamp }));
      }
      ignoreSyncEvents = false;
      return;
    }

    if (action === 'p2p_pong') {
      // Calculate Round-Trip Time (RTT) and average one-way transit delay
      const rtt = Date.now() - data.timestamp;
      oneWayLatency = rtt / 2;
      console.log(`[Sync] Latency updated: RTT = ${rtt}ms, One-Way delay = ${oneWayLatency}ms`);
      ignoreSyncEvents = false;
      return;
    }

    // ----------------------------------------------------
    // Playback sync execution with latency compensation
    // ----------------------------------------------------
    const latencyOffsetSeconds = oneWayLatency / 1000;

    if (action === 'play') {
      const compensatedTime = Math.min(video.duration || Infinity, data.time + latencyOffsetSeconds);
      console.log(`[Sync Remote] Action: PLAY, Original Time: ${data.time}s, Compensated: ${compensatedTime}s`);
      
      video.currentTime = compensatedTime;
      video.play().catch(err => console.error('[Sync] Playback failed:', err));

    } else if (action === 'pause') {
      console.log('[Sync Remote] Action: PAUSE');
      video.pause();

    } else if (action === 'seek') {
      const compensatedTime = Math.min(video.duration || Infinity, data.time + latencyOffsetSeconds);
      console.log(`[Sync Remote] Action: SEEK, Original Time: ${data.time}s, Compensated: ${compensatedTime}s`);
      
      video.currentTime = compensatedTime;

    } else if (action === 'rate') {
      console.log('[Sync Remote] Action: SPEED CHANGE to:', data.rate);
      video.playbackRate = data.rate;
    }

    // Release sync events lock after browser finishes rendering and updating state
    setTimeout(() => {
      ignoreSyncEvents = false;
    }, 250);

  } catch (err) {
    console.error('[Sync] Error processing remote synchronization message:', err);
    ignoreSyncEvents = false;
  }
}

// Peer-to-Peer Round-Trip-Time calibration triggers
function startLatencyPings() {
  stopLatencyPings();
  
  console.log('[Sync] Launching real-time peer RTT latency pings.');
  pingInterval = setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN && peersCount === 2) {
      socket.send(JSON.stringify({ action: 'p2p_ping', timestamp: Date.now() }));
    }
  }, 5000);
}

function stopLatencyPings() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  oneWayLatency = 0;
}

// Reset client connection state
function cleanupConnection() {
  stopLatencyPings();
  if (socket) {
    socket.close();
    socket = null;
  }
  connectionStatus = 'Disconnected';
  peersCount = 0;
  currentRoomId = null;
  console.log('[Sync] Cleanup executed. Synchronizer reset.');
}

// Send standard sync payload to server
function sendSyncMessage(payload) {
  if (socket && socket.readyState === WebSocket.OPEN && peersCount === 2) {
    socket.send(JSON.stringify(payload));
  }
}
