const isNetflix = window.location.hostname.includes('netflix.com');

// Local state — kept in sync with background via port messages
let connectionStatus = 'Disconnected';
let peersCount = 0;
let oneWayLatency = 0;
let ignoreSyncEvents = false;

let videoElement = null;
let eventListenersBound = false;

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

  video.addEventListener('play', () => {
    if (ignoreSyncEvents) return;
    port.postMessage({ action: 'play', time: video.currentTime });
  });

  video.addEventListener('pause', () => {
    if (ignoreSyncEvents) return;
    port.postMessage({ action: 'pause', time: video.currentTime });
  });

  video.addEventListener('seeked', () => {
    if (ignoreSyncEvents) return;
    port.postMessage({ action: 'seek', time: video.currentTime });
  });

  video.addEventListener('ratechange', () => {
    if (ignoreSyncEvents) return;
    port.postMessage({ action: 'rate', rate: video.playbackRate });
  });

  eventListenersBound = true;
}

// Handle messages from popup (CONNECT, GET_STATUS)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'CONNECT') {
    connectionStatus = 'Connecting';
    port.postMessage({ action: 'CONNECT', roomId: message.roomId });
    sendResponse({ success: true });
    return;
  }

  if (message.action === 'DISCONNECT') {
    port.postMessage({ action: 'DISCONNECT' });
    connectionStatus = 'Disconnected';
    peersCount = 0;
    oneWayLatency = 0;
    sendResponse({ success: true });
    return;
  }

  if (message.action === 'GET_STATUS') {
    sendResponse({
      status: connectionStatus,
      peersCount,
      latency: peersCount === 2 ? oneWayLatency : null,
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
    } else if (msg.status === 'peer_disconnected') {
      peersCount = 1;
      // TODO: more robust handling of mid-session disconnects (e.g. pause and alert, or even remove the peer count limit and just alert?)
      // alert('Remote user has disconnected.');
    }
    return;
  }

  if (action === 'latency_update') {
    oneWayLatency = msg.latency;
    return;
  }

  if (action === 'error') {
    connectionStatus = 'Disconnected';
    peersCount = 0;
    oneWayLatency = 0;
    // Connection-level failures (e.g. server unavailable) disconnect silently;
    // actionable server errors (room full, etc.) still surface to the user.
    if (msg.silent) {
      console.warn(`[RVS] ${msg.message}`);
    } else {
      alert(`[Sync Error] ${msg.message}`);
    }
    return;
  }

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
