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

  // Read from the manifest so it never drifts from the shipped version.
  const versionEl = document.getElementById('version');
  if (versionEl) versionEl.textContent = 'v' + chrome.runtime.getManifest().version;

  let currentStatus = 'Disconnected';

  // True once the Room ID field has received a real value (from content.js)
  // or a direct user edit (typing, Regenerate, Paste) — after that, this
  // popup-open session never programmatically touches the field again, no
  // matter what the field holds. Without this, clearing the field to type a
  // new ID left a window where the field was momentarily empty; the 1s
  // status poll saw that as "safe to prefill" and put the old value back,
  // fighting the user's own edit.
  //
  // While still unlocked, the field holds either nothing or a locally
  // generated placeholder (from updateUIForUnsupportedPage) — never a real
  // value, since receiving one locks the field immediately. That's what lets
  // the watchStatus guard below check just isRoomIdLocked: a transient
  // content-script hiccup right after a real navigation can trigger
  // "Unsupported Page" for a single poll tick before the fresh content
  // script finishes loading, and this way the real Room ID that follows can
  // still land once it arrives.
  let isRoomIdLocked = false;

  // See popup-channel.js — hides chrome.tabs.query/sendMessage and
  // normalizes the lastError-means-unsupported-page case to a null response.
  const channel = window.RVS.createPopupChannel();

  // Copy the given text to the clipboard and flash the Copy button.
  /** @param {string} text */
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

  // Applies a connection status to the status readout and the Connect/
  // Disconnect button label — the single place that decides what each status
  // looks like, so the four call sites (two optimistic updates sent before
  // the next poll confirms, the poll itself, and the unsupported-page
  // fallback) can never independently disagree on shape again. They briefly
  // did: CONNECT's optimistic update hardcoded 'Connecting...', but the poll
  // wrote the raw 'Connecting' a moment later, flickering. textOverride
  // covers the one legitimate case where the displayed text differs from the
  // status driving currentStatus/the button label ('Unsupported Page' shows
  // while currentStatus is still 'Disconnected').
  /**
   * @param {string} status
   * @param {string} [textOverride]
   */
  function renderStatus(status, textOverride) {
    currentStatus = status;
    statusValue.textContent = textOverride || (status === 'Connecting' ? 'Connecting...' : status);
    statusValue.className = 'status-value status-' + (
      status === 'Connected' ? 'connected' :
      status === 'Connecting' ? 'connecting' :
      'disconnected'
    );
    connectBtn.textContent = (status === 'Connected' || status === 'Connecting') ? 'Disconnect' : 'Connect';
  }

  // Only http(s) URLs on YouTube/Netflix become clickable links. The peer's URL
  // is untrusted, so this blocks javascript:/data: and other schemes that would
  // otherwise execute in the popup when clicked.
  /** @param {string} url */
  function isSafeMediaUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
      const host = u.hostname.toLowerCase();
      return window.RVS.isHost(host, 'youtube.com')
        || window.RVS.isHost(host, 'youtu.be')
        || window.RVS.isHost(host, 'netflix.com');
    } catch (_) {
      return false;
    }
  }

  // Render a media entry into `el` as a hyperlink (or plain text if the URL isn't
  // a trusted, clickable one). Built with createElement/textContent — never
  // innerHTML — so a malicious title/URL can't inject markup.
  /**
   * @param {HTMLElement} el
   * @param {{ title: string, url: string } | null} media
   */
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
    // Unsupported pages have no content script to provide/persist an ID, so
    // seed one locally when the field is empty. Deliberately doesn't lock the
    // field: a genuine roomId (e.g. once a fresh content script finishes
    // loading after a real navigation) can still replace this placeholder.
    if (!isRoomIdLocked && !roomIdInput.value) {
      roomIdInput.value = window.RVS.generateRoomId();
    }

    renderStatus('Disconnected', 'Unsupported Page');
    peersValue.textContent = '0 / 2';
    latencyValue.textContent = '-- ms';
    renderMedia(peerMediaEl, null);
  }

  genBtn.addEventListener('click', () => {
    const roomId = window.RVS.generateRoomId();
    roomIdInput.value = roomId;
    isRoomIdLocked = true;
    copyRoomId(roomId);
  });

  // Manual edits lock the field — never auto-filled again this popup session.
  roomIdInput.addEventListener('input', () => {
    isRoomIdLocked = true;
  });

  copyBtn.addEventListener('click', () => {
    const text = roomIdInput.value.trim().toUpperCase();
    if (!text) {
      alert('Room ID is empty.');
      return;
    }
    copyRoomId(text);
  });

  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        roomIdInput.value = text.trim().toUpperCase();
        isRoomIdLocked = true;
      }
    } catch (err) {
      console.warn('Clipboard read restricted:', err);
      alert('Clipboard access is restricted by the browser. Please use Ctrl+V / Cmd+V to paste.');
    }
  });

  connectBtn.addEventListener('click', () => {
    // If already connected/connecting, this button disconnects instead.
    if (currentStatus === 'Connected' || currentStatus === 'Connecting') {
      channel.send({ action: 'DISCONNECT' }, (response) => {
        if (!response) {
          updateUIForUnsupportedPage();
          return;
        }
        renderStatus('Disconnected');
      });
      return;
    }

    const roomId = roomIdInput.value.trim().toUpperCase();

    if (!roomId) {
      alert('Please enter a Room ID'); // Native alert as explicitly requested for MVP simplicity
      return;
    }

    channel.send({ action: 'CONNECT', roomId: roomId }, (response) => {
      if (!response) {
        updateUIForUnsupportedPage();
        return;
      }

      if (response.success) {
        renderStatus('Connecting');
      } else {
        const errMsg = (response && response.error) ? response.error : 'Unknown error';
        alert(`Failed to trigger connection: ${errMsg}`);
      }
    });
  });

  // The channel polls internally (see popup-channel.js) and tears the poll
  // down when the popup document closes.
  channel.watchStatus((response) => {
    if (!response) {
      updateUIForUnsupportedPage();
      return;
    }

    // Prefill the field with this tab's room (active room, or the stable
    // per-tab suggestion the content script persists) — once, then lock it.
    if (!isRoomIdLocked && response.roomId) {
      roomIdInput.value = response.roomId;
      isRoomIdLocked = true;
    }

    renderStatus(response.status);
    peersValue.textContent = `${response.peersCount} / 2`;

    if (response.latency !== null && response.latency !== undefined) {
      latencyValue.textContent = `${Math.round(response.latency)} ms`;
    } else {
      latencyValue.textContent = '-- ms';
    }

    renderMedia(peerMediaEl, response.peerMediaInfo);
  });
});
