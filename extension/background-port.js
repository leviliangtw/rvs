// background-port.js — content.js's reconnecting port to background.js.
// Owns creating the chrome.runtime.connect port, reconnecting it when it
// dies, and sending safely — content.js supplies what a message means
// (onMessage) and what to do once a connection is live (onConnect). This
// module has no idea what a "room" or "connection state" is.
//
// A port can die without content.js being re-injected: a same-tab
// back/forward restore from the bfcache resumes that exact script instance
// with its old, already-dead port (see the pageshow listener below), and a
// service-worker restart kills the port even while the page never navigates
// at all. connect() runs again in both cases so `port` always ends up
// pointing at a live connection; send() guards individual sends against the
// brief window before a dead port is detected.

(() => {
  'use strict';

  // Running the WebSocket in background.js (not here) bypasses the page's
  // CSP (Netflix blocks ws:// connections from content scripts via its
  // strict connect-src), and the open port keeps the MV3 service worker
  // alive for the tab's lifetime.
  function createBackgroundPort({ onMessage, onConnect }) {
    let port = null;

    function send(msg) {
      if (!port) return;
      try {
        port.postMessage(msg);
      } catch (err) {
        console.warn('[RVS] send failed, reconnecting:', err);
        connect();
      }
    }

    function connect() {
      try {
        port = chrome.runtime.connect({ name: 'rvs-port' });
      } catch (err) {
        // Extension context invalidated (e.g. the extension was
        // reloaded/updated while this page was open) — nothing left to
        // reconnect to until the page itself reloads.
        console.error('[RVS] Failed to connect to background.js:', err);
        port = null;
        return;
      }

      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(connect);

      // Runs on every successful connect — the very first one and every
      // reconnect alike — with this module's own send() passed straight in
      // (avoids the caller needing a reference to this factory's own return
      // value before it exists).
      onConnect(send);
    }

    connect();

    // A same-tab back/forward restore resumes this exact script instance
    // with its old port already dead — reconnect the moment the page
    // becomes interactive again, rather than waiting for the next send()
    // to discover it the hard way.
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) connect();
    });

    return { send };
  }

  window.RVS = { ...window.RVS, createBackgroundPort };
})();
