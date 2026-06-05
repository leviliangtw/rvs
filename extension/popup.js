document.addEventListener('DOMContentLoaded', () => {
  const roomIdInput = /** @type {HTMLInputElement} */ (document.getElementById('room-id'));
  const connectBtn = document.getElementById('connect-btn');
  const statusValue = document.getElementById('status-value');
  const peersValue = document.getElementById('peers-value');
  const latencyValue = document.getElementById('latency-value');
  const genBtn = document.getElementById('gen-btn');
  const copyBtn = document.getElementById('copy-btn');
  const pasteBtn = document.getElementById('paste-btn');
  const peerMediaEl = document.getElementById('peer-media');

  // Tracks the latest known connection status so the button can toggle behavior.
  let currentStatus = 'Disconnected';

  // Load saved Room ID on opening
  chrome.storage.local.get(['savedRoomId'], (result) => {
    if (result.savedRoomId) {
      roomIdInput.value = String(result.savedRoomId);
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

  // Handle Connect/Disconnect toggle click
  connectBtn.addEventListener('click', () => {
    // If already connected/connecting, this button disconnects instead.
    if (currentStatus === 'Connected' || currentStatus === 'Connecting') {
      sendMessageToActiveTab({ action: 'DISCONNECT' }, () => {
        if (chrome.runtime.lastError) {
          updateUIForUnsupportedPage();
          return;
        }
        currentStatus = 'Disconnected';
        statusValue.textContent = 'Disconnected';
        statusValue.className = 'status-value status-disconnected';
        setConnectBtnLabel('Disconnected');
      });
      return;
    }

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
        currentStatus = 'Connecting';
        statusValue.textContent = 'Connecting...';
        statusValue.className = 'status-value status-connecting';
        setConnectBtnLabel('Connecting');
      } else {
        const errMsg = (response && response.error) ? response.error : 'Unknown error';
        alert(`Failed to trigger connection: ${errMsg}`);
      }
    });
  });

  // Periodically poll content script for connection status updates.
  // No handle kept: the interval lives for the popup's lifetime and is torn
  // down automatically when the popup document closes.
  setInterval(updateStatus, 1000);
  updateStatus(); // Immediate initial check

  function updateStatus() {
    sendMessageToActiveTab({ action: 'GET_STATUS' }, (response) => {
      if (chrome.runtime.lastError) {
        updateUIForUnsupportedPage();
        return;
      }

      if (response) {
        // Update connection status
        currentStatus = response.status;
        statusValue.textContent = response.status;
        if (response.status === 'Connected') {
          statusValue.className = 'status-value status-connected';
        } else if (response.status === 'Connecting') {
          statusValue.className = 'status-value status-connecting';
        } else {
          statusValue.className = 'status-value status-disconnected';
        }
        setConnectBtnLabel(response.status);

        // Update peer counts
        peersValue.textContent = `${response.peersCount} / 2`;

        // Update latency readings
        if (response.latency !== null && response.latency !== undefined) {
          latencyValue.textContent = `${Math.round(response.latency)} ms`;
        } else {
          latencyValue.textContent = '-- ms';
        }

        // Update the peer's "Now Watching" link
        renderMedia(peerMediaEl, response.peerMedia);
      }
    });
  }

  // Only http(s) URLs on YouTube/Netflix become clickable links. The peer's URL
  // is untrusted, so this blocks javascript:/data: and other schemes that would
  // otherwise execute in the popup when clicked.
  function isSafeMediaUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
      const host = u.hostname.toLowerCase();
      return /(^|\.)youtube\.com$/.test(host)
        || host === 'youtu.be'
        || /(^|\.)netflix\.com$/.test(host);
    } catch (_) {
      return false;
    }
  }

  // Render a media entry into `el` as a hyperlink (or plain text if the URL isn't
  // a trusted, clickable one). Built with createElement/textContent — never
  // innerHTML — so a malicious title/URL can't inject markup.
  function renderMedia(el, media) {
    el.replaceChildren();
    if (!media || !media.url) {
      el.textContent = '—';
      el.removeAttribute('title');
      return;
    }

    const label = media.title || media.url;
    el.setAttribute('title', label); // full title on hover (value is ellipsized)

    if (isSafeMediaUrl(media.url)) {
      const link = document.createElement('a');
      link.href = media.url;
      link.textContent = label;
      // Navigate the current tab instead of opening a new window — clicking the
      // peer's title "joins" what they're watching in place.
      link.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.tabs.update({ url: media.url });
        window.close();
      });
      el.appendChild(link);
    } else {
      el.textContent = label; // untrusted URL: show the title, but not as a link
    }
  }

  function updateUIForUnsupportedPage() {
    currentStatus = 'Disconnected';
    statusValue.textContent = 'Unsupported Page';
    statusValue.className = 'status-value status-disconnected';
    peersValue.textContent = '0 / 2';
    latencyValue.textContent = '-- ms';
    setConnectBtnLabel('Disconnected');
    renderMedia(peerMediaEl, null);
  }

  // Button shows "Disconnect" while active, "Connect" otherwise.
  function setConnectBtnLabel(status) {
    connectBtn.textContent =
      (status === 'Connected' || status === 'Connecting') ? 'Disconnect' : 'Connect';
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
