importScripts('config.js', 'tab-session.js');

// tabId → TabSession (see tab-session.js). background.js only ever calls
// into a session's public interface (rebind/disconnect/handlePortMessage/
// getStatus) — it never touches a session's WebSocket, port, or room state
// directly.
const tabStates = new Map();

// Content scripts connect here; the open port keeps the service worker alive.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'rvs-sync') return;

  const tabId = port.sender.tab.id;

  let session = tabStates.get(tabId);
  if (!session) {
    session = createTabSession(tabId, { updateIcon });
    tabStates.set(tabId, session);
  }

  session.rebind(port);

  port.onMessage.addListener((msg) => session.handlePortMessage(msg));
  port.onDisconnect.addListener(() => {
    const lastErrorMessage = chrome.runtime.lastError && chrome.runtime.lastError.message;
    if (session.disconnect(port, lastErrorMessage)) {
      tabStates.delete(tabId);
    }
  });
});

// Repaint the icon to match this tab's real connection state when it navigates
// or reloads. A SPA soft navigation (e.g. YouTube video -> home and back) fires
// 'loading' but doesn't drop the port/socket, so the connection is still alive;
// painting an unconditional red here made the icon lie and stay red. A real
// reload has no live state yet (the port disconnected), so it correctly shows
// Disconnected until the session resumes.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    const session = tabStates.get(tabId);
    updateIcon(tabId, session ? session.getStatus() : 'Disconnected');
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
