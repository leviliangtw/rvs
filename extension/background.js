// Service worker for Remote Video Synchronizer (RVS)
// Dynamically renders real-time status icons on the Chrome toolbar using OffscreenCanvas.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'UPDATE_STATUS' && sender.tab) {
    const tabId = sender.tab.id;
    updateIcon(tabId, message.status);
  }
});

// Reset icon when tab navigates or reloads
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    updateIcon(tabId, 'Disconnected');
  }
});

function updateIcon(tabId, status) {
  let color = '#ff5252'; // Red (Disconnected)
  if (status === 'Connecting') {
    color = '#ffb300'; // Yellow
  } else if (status === 'Connected') {
    color = '#00e676'; // Green
  }

  // Draw high-resolution icon dynamically using OffscreenCanvas
  const canvas = new OffscreenCanvas(32, 32);
  const ctx = canvas.getContext('2d');

  // Clear canvas for drawing transparent background context
  ctx.clearRect(0, 0, 32, 32);

  // Draw solid colored background circle
  ctx.beginPath();
  ctx.arc(16, 16, 14, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();

  // Draw outer overlay border for depth
  ctx.beginPath();
  ctx.arc(16, 16, 14, 0, 2 * Math.PI);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
  ctx.stroke();

  // Draw inner play symbol (white triangle) in center
  ctx.beginPath();
  ctx.moveTo(13, 11);
  ctx.lineTo(13, 21);
  ctx.lineTo(21, 16);
  ctx.closePath();
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  // Retrieve ImageData and set toolbar icon for the target tab context
  const imageData = ctx.getImageData(0, 0, 32, 32);
  chrome.action.setIcon({ tabId: tabId, imageData: imageData }, () => {
    // Silence runtime error if tab is closed rapidly before callback completes
    const err = chrome.runtime.lastError;
  });
}
