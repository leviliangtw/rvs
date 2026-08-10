/**
 * @fileoverview Wires up the popup UI: the Room ID field, Connect/
 * Disconnect button, and the peer's status/media panel. Talks to the
 * active tab's content script through the Popup Channel
 * (popup-channel.js) and never touches chrome.tabs or
 * chrome.runtime.lastError directly.
 */

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
  if (versionEl) {
    versionEl.textContent = 'v' + chrome.runtime.getManifest().version;
  }

  let currentStatus = 'Disconnected';

  // True once the Room ID field has a real value (from content.js) or a
  // direct user edit (typing, Regenerate, Paste) — after that this popup
  // session never programmatically touches the field again. Without this,
  // clearing the field to type a new ID left a brief window where the 1s
  // status poll saw "empty" as safe to prefill and fought the user's edit.
  //
  // While unlocked, the field holds only nothing or a local placeholder
  // (never a real value — receiving one locks it immediately), which is
  // why the watchStatus guard below can check just isRoomIdLocked: a
  // transient "Unsupported Page" hiccup right after navigation won't
  // block the real Room ID from landing once it arrives.
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
  // Disconnect button label — the single place that decides what each
  // status looks like, so its call sites can never disagree on shape again
  // (they briefly did: an optimistic 'Connecting...' flickered against the
  // poll's raw 'Connecting' a moment later). textOverride covers the one
  // legitimate mismatch: 'Unsupported Page' displays while currentStatus
  // stays 'Disconnected'.
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

  // Only http(s) URLs on YouTube/Netflix become clickable links — the
  // peer's URL is untrusted, so this blocks javascript:/data: and other
  // schemes that would otherwise execute in the popup when clicked.
  /** @param {string} url */
  function isSafeMediaUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        return false;
      }
      const host = u.hostname.toLowerCase();
      return window.RVS.isHost(host, 'youtube.com')
        || window.RVS.isHost(host, 'youtu.be')
        || window.RVS.isHost(host, 'netflix.com');
    } catch (_) {
      return false;
    }
  }

  // Render a media entry into `el` as a hyperlink (or plain text if the URL
  // isn't trusted/clickable). Built with createElement/textContent, never
  // innerHTML, so a malicious title/URL can't inject markup.
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
      // content.js decides navigate-vs-resync (it has live isDifferentVideoFromPeer()
      // state; the popup only has this poll's snapshot) — see Join Peer in CLAUDE.md.
      link.addEventListener('click', (e) => {
        e.preventDefault();
        console.log('[RVS] popup: JOIN_PEER clicked, media=', media);
        channel.send({ action: 'JOIN_PEER' }, () => {});
        window.close();
      });
      el.appendChild(link);
    } else {
      el.textContent = label; // untrusted URL: show the title, but not as a link
    }
  }

  function updateUIForUnsupportedPage() {
    // Unsupported pages have no content script to persist an ID, so seed
    // one locally when the field is empty. Deliberately doesn't lock the
    // field, so a genuine roomId (once a real content script loads) can
    // still replace this placeholder.
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
