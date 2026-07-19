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

  // Show the extension version (read from the manifest, so it never drifts).
  const versionEl = document.getElementById('version');
  if (versionEl) versionEl.textContent = 'v' + chrome.runtime.getManifest().version;

  // Tracks the latest known connection status so the button can toggle behavior.
  let currentStatus = 'Disconnected';

  // The push port to this tab's content script (null until connected / on an
  // unsupported page). Status snapshots are pushed over it; the popup no longer
  // polls.
  let port = null;

  // A CONNECT/DISCONNECT the user clicked before the port was ready (port still
  // connecting, or a slow page where the content script hasn't injected yet). It's
  // sent automatically once the port delivers its first status snapshot, so a click
  // is never silently lost.
  let pendingCommand = null;

  // The Room ID is per-tab: it's prefilled from the active tab's own state
  // (reported by its content script), never from global storage. A fresh tab
  // gets a stable generated ID — the content script persists it in
  // sessionStorage (isRoomPrefilled), so reopening the popup keeps the same ID
  // instead of a new random one. We only write the field when it's empty, so we
  // never clobber what the user is typing.

  // Returns a random 6-char Room ID (A-Z0-9).
  function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  // Copy the given text to the clipboard and flash the Copy button. Shared by
  // the Copy button and Regenerate (which auto-copies the fresh ID).
  async function copyRoomId(text) {
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
  }

  // Regenerate Room ID — replace the field with a fresh ID and copy it so it's
  // ready to share immediately.
  genBtn.addEventListener('click', () => {
    const roomId = generateRoomId();
    roomIdInput.value = roomId;
    copyRoomId(roomId);
  });

  // Copy Room ID
  copyBtn.addEventListener('click', () => {
    const text = roomIdInput.value.trim().toUpperCase();
    if (!text) {
      alert('Room ID is empty.');
      return;
    }
    copyRoomId(text);
  });

  // Paste Room ID
  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        roomIdInput.value = text.trim().toUpperCase();
      }
    } catch (err) {
      console.warn('Clipboard read restricted:', err);
      alert('Clipboard access is restricted by the browser. Please use Ctrl+V / Cmd+V to paste.');
    }
  });

  // Handle Connect/Disconnect toggle click. Commands go over the push port; the
  // resulting status arrives back as a pushed snapshot (no response callback). If
  // the port isn't ready yet (slow page / content script still injecting), the
  // command is queued via sendOrQueue() and sent once the port connects — so a
  // click is never lost and the button always does something.
  connectBtn.addEventListener('click', () => {
    // If already connected/connecting, this button disconnects instead.
    if (currentStatus === 'Connected' || currentStatus === 'Connecting') {
      sendOrQueue({ action: 'DISCONNECT' });
      return;
    }

    const roomId = roomIdInput.value.trim().toUpperCase();

    if (!roomId) {
      alert('Please enter a Room ID'); // Native alert as explicitly requested for MVP simplicity
      return;
    }

    // content.js persists the room per-tab in sessionStorage and pushes back the
    // 'Connecting' status immediately.
    sendOrQueue({ action: 'CONNECT', roomId });
  });

  // Open the push port to the active tab's content script. The content script
  // pushes a snapshot on connect and on every state change, so there's no poll.
  // The connect is retried, and can be re-triggered by a user click (see
  // ensureConnecting), so a content script that's slow to inject on a heavy page
  // never leaves the popup permanently stuck on "Unsupported Page".
  const MAX_CONNECT_ATTEMPTS = 6; // ~1.8s of retries before declaring the page unsupported
  let connectAttempts = 0;
  let reconnectTimer = null;
  let isConnecting = false;

  // The active tab, resolved once we query it. Needed by the sendMessage fallback,
  // which addresses the content script by tab id instead of holding a port.
  let activeTabId = null;

  // Fallback transport: on engines where chrome.tabs.connect isn't supported (it
  // throws — see below), the popup can't hold a push port, so it polls the content
  // script over chrome.tabs.sendMessage instead. Latched for this popup's lifetime
  // once a throw proves the port API is unavailable.
  let fallbackMode = false;

  function connectToTab() {
    reconnectTimer = null;
    isConnecting = true;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      isConnecting = false;
      if (!tabs || tabs.length === 0 || tabs[0].id == null) {
        updateUIForUnsupportedPage();
        return;
      }
      activeTabId = tabs[0].id;

      // Chromium returns a port here even on pages with no content script (it
      // just disconnects). Some non-Chromium engines that emulate the extension
      // API (e.g. Orion on iOS/iPadOS) instead throw synchronously from
      // tabs.connect. A throw means the port API isn't available on this engine at
      // all — retrying won't help — so switch to the sendMessage polling fallback,
      // which uses only APIs those engines do support.
      let p;
      try {
        p = chrome.tabs.connect(activeTabId, { name: 'rvs-popup' });
      } catch (_) {
        startFallback();
        return;
      }
      port = p;
      let gotSnapshot = false;

      p.onMessage.addListener((msg) => {
        gotSnapshot = true;
        connectAttempts = 0;
        // Latency arrives on its own narrow message (~every 5s) so it updates just
        // that field; full snapshots ('status') re-render everything.
        if (msg && msg.kind === 'latency') {
          renderLatency(msg.latency);
        } else {
          renderStatus(msg);
          flushPendingCommand(); // port is live and the content script is ready
        }
      });

      p.onDisconnect.addListener(() => {
        void chrome.runtime.lastError; // clear "receiving end does not exist"
        if (port === p) port = null;
        // A snapshot means this was a live port now closing (popup closing) —
        // nothing to do. No snapshot means the content script isn't there yet; on a
        // fresh page load it may still be injecting, so retry before giving up.
        if (gotSnapshot) return;
        scheduleReconnect();
      });
    });
  }

  // Retry the port connect on a bounded budget. When it's exhausted the page is
  // treated as unsupported — but a user click resets the budget (ensureConnecting),
  // so the popup is never permanently dead on a page that was just slow to inject.
  function scheduleReconnect() {
    if (reconnectTimer || isConnecting) return; // a reconnect is already pending
    if (connectAttempts >= MAX_CONNECT_ATTEMPTS) {
      pendingCommand = null; // genuinely no content script — drop the queued intent
      updateUIForUnsupportedPage();
      return;
    }
    connectAttempts++;
    reconnectTimer = setTimeout(connectToTab, 300);
  }

  // Ensure a connect attempt is in flight, resetting the retry budget. Called on a
  // user action so a page previously declared unsupported (because the content
  // script was slow) gets a fresh chance instead of staying stuck.
  function ensureConnecting() {
    connectAttempts = 0;
    if (port || isConnecting) return; // already connected / connecting
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    connectToTab();
  }

  // Send a command now if a transport is live; otherwise queue it and (re)connect.
  // The queued command is flushed once the port delivers a snapshot (or, in fallback
  // mode, sent immediately). The postMessage is guarded so a port that disconnected
  // mid-use can't throw and swallow the click.
  function sendOrQueue(message) {
    if (fallbackMode) {
      sendViaFallback(message);
      return;
    }
    if (port) {
      try {
        port.postMessage(message);
        return;
      } catch (_) {
        port = null; // disconnected between checks — fall through to reconnect
      }
    }
    pendingCommand = message;
    ensureConnecting();
  }

  // Drain the queued command once a transport is live. Re-queues on failure so a
  // disconnect race retries on the next connect rather than dropping the intent.
  function flushPendingCommand() {
    if (!pendingCommand) return;
    const cmd = pendingCommand;
    pendingCommand = null;
    if (fallbackMode) { sendViaFallback(cmd); return; }
    if (!port) { pendingCommand = cmd; return; }
    try { port.postMessage(cmd); } catch (_) { pendingCommand = cmd; }
  }

  // --- sendMessage fallback (for engines without tabs.connect ports) -----------

  // Enter fallback mode: poll status immediately and then on a timer, and flush any
  // command the user queued before the transport was known. One-way latched.
  function startFallback() {
    if (fallbackMode) return;
    fallbackMode = true;
    port = null;
    pollStatus();
    setInterval(pollStatus, 1000); // popup lifecycle ends the timer; guarded from re-entry above
    flushPendingCommand();
  }

  // Poll the content script for a fresh snapshot. A missing content script (no
  // receiver) means this really is an unsupported page.
  function pollStatus() {
    if (activeTabId == null) return;
    chrome.tabs.sendMessage(activeTabId, { action: 'GET_STATUS' }, renderPollResponse);
  }

  // Send a CONNECT/DISCONNECT over the fallback transport and render the snapshot
  // it returns, so the UI updates without waiting for the next poll tick.
  function sendViaFallback(message) {
    if (activeTabId == null) { updateUIForUnsupportedPage(); return; }
    chrome.tabs.sendMessage(activeTabId, message, renderPollResponse);
  }

  // Shared handler for fallback responses. No response (lastError) means the content
  // script isn't answering — show the page as unsupported, but keep the poll timer
  // running so a content script that's still injecting on a heavy page recovers on a
  // later tick (matching the pre-push polling behavior) instead of latching stuck.
  function renderPollResponse(response) {
    if (chrome.runtime.lastError || !response) {
      updateUIForUnsupportedPage();
      return;
    }
    renderStatus(response);
    renderLatency(response.latency); // fallback snapshots carry latency inline
  }

  connectToTab();

  // Apply a pushed status snapshot to the UI.
  function renderStatus(response) {
    if (!response) return;

    // Prefill the field with this tab's room (active room, or the stable per-tab
    // suggestion the content script persists). Only when empty, so a later push
    // never overwrites what the user is typing.
    if (!roomIdInput.value && response.roomId) {
      roomIdInput.value = response.roomId;
    }

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

    // Latency is intentionally not handled here — it's owned by its own 'latency'
    // message (see the port.onMessage branch) so the ~5s refresh never re-renders
    // the rest of this snapshot.

    // Update the peer's "Now Watching" link
    renderMedia(peerMediaEl, response.peerMedia);
  }

  // Render just the latency field. Shared by full snapshots and the standalone
  // latency push, so the ~5s latency refresh touches only this readout.
  function renderLatency(latency) {
    latencyValue.textContent =
      (latency !== null && latency !== undefined) ? `${Math.round(latency)} ms` : '-- ms';
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

  // The url+title of the media currently rendered, so repeat snapshots (e.g. the
  // ~5s latency pushes) don't needlessly rebuild the link. `undefined` until the
  // first render so the initial empty state is always drawn.
  let lastMediaKey;

  // Render a media entry into `el` as a hyperlink (or plain text if the URL isn't
  // a trusted, clickable one). Built with createElement/textContent — never
  // innerHTML — so a malicious title/URL can't inject markup. No-ops when the
  // media is unchanged from what's already shown.
  function renderMedia(el, media) {
    const key = media && media.url ? `${media.url}\n${media.title || ''}` : '';
    if (key === lastMediaKey) return;
    lastMediaKey = key;

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
    // Unsupported pages have no content script to provide/persist an ID, so seed
    // one locally when the field is empty — the field is ready to share from any
    // tab. (Without a content script this can't persist across popup opens.)
    if (!roomIdInput.value) roomIdInput.value = generateRoomId();

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
});
