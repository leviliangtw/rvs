document.addEventListener('DOMContentLoaded', () => {
  const roomIdInput = document.getElementById('room-id');
  const connectBtn = document.getElementById('connect-btn');
  const statusValue = document.getElementById('status-value');
  const peersValue = document.getElementById('peers-value');
  const latencyValue = document.getElementById('latency-value');
  const genBtn = document.getElementById('gen-btn');
  const copyBtn = document.getElementById('copy-btn');
  const pasteBtn = document.getElementById('paste-btn');

  // Load saved Room ID on opening
  chrome.storage.local.get(['savedRoomId'], (result) => {
    if (result.savedRoomId) {
      roomIdInput.value = result.savedRoomId;
    }
  });

  // Generate Room ID
  genBtn.addEventListener('click', () => {
    const randomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    roomIdInput.value = randomCode;
    chrome.storage.local.set({ savedRoomId: randomCode });
  });

  // Copy Room ID
  copyBtn.addEventListener('click', async () => {
    const text = roomIdInput.value.trim().toUpperCase();
    if (!text) {
      alert('Room ID is empty.');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      const originalText = copyBtn.textContent;
      copyBtn.textContent = 'Copied!';
      setTimeout(() => {
        copyBtn.textContent = originalText;
      }, 1500);
    } catch (err) {
      console.error('Clipboard copy failed:', err);
    }
  });

  // Paste Room ID
  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        roomIdInput.value = text.trim().toUpperCase();
        chrome.storage.local.set({ savedRoomId: roomIdInput.value });
      }
    } catch (err) {
      console.warn('Clipboard read restricted:', err);
      alert('Clipboard access is restricted by the browser. Please use Ctrl+V / Cmd+V to paste.');
    }
  });

  // Handle Connect click
  connectBtn.addEventListener('click', () => {
    const roomId = roomIdInput.value.trim().toUpperCase();

    if (!roomId) {
      alert('Please enter a Room ID'); // Native alert as explicitly requested for MVP simplicity
      return;
    }

    // Save Room ID for convenience
    chrome.storage.local.set({ savedRoomId: roomId });

    // Send connection command to the active tab's content script
    sendMessageToActiveTab({ action: 'CONNECT', roomId: roomId }, (response) => {
      if (chrome.runtime.lastError) {
        updateUIForUnsupportedPage();
        return;
      }

      if (response && response.success) {
        statusValue.textContent = 'Connecting...';
        statusValue.className = 'status-value status-connecting';
      } else {
        const errMsg = (response && response.error) ? response.error : 'Unknown error';
        alert(`Failed to trigger connection: ${errMsg}`);
      }
    });
  });

  // Periodically poll content script for connection status updates
  let pollInterval = setInterval(updateStatus, 1000);
  updateStatus(); // Immediate initial check

  function updateStatus() {
    sendMessageToActiveTab({ action: 'GET_STATUS' }, (response) => {
      if (chrome.runtime.lastError) {
        updateUIForUnsupportedPage();
        return;
      }

      if (response) {
        // Update connection status
        statusValue.textContent = response.status;
        if (response.status === 'Connected') {
          statusValue.className = 'status-value status-connected';
        } else if (response.status === 'Connecting') {
          statusValue.className = 'status-value status-connecting';
        } else {
          statusValue.className = 'status-value status-disconnected';
        }

        // Update peer counts
        peersValue.textContent = `${response.peersCount} / 2`;

        // Update latency readings
        if (response.latency !== null && response.latency !== undefined) {
          latencyValue.textContent = `${Math.round(response.latency)} ms`;
        } else {
          latencyValue.textContent = '-- ms';
        }
      }
    });
  }

  function updateUIForUnsupportedPage() {
    statusValue.textContent = 'Unsupported Page';
    statusValue.className = 'status-value status-disconnected';
    peersValue.textContent = '0 / 2';
    latencyValue.textContent = '-- ms';
  }

  // Helper to send message to the content script of the active tab
  function sendMessageToActiveTab(message, callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || tabs.length === 0) {
        if (callback) callback(null);
        return;
      }

      const activeTabId = tabs[0].id;
      chrome.tabs.sendMessage(activeTabId, message, (response) => {
        if (callback) callback(response);
      });
    });
  }
});
