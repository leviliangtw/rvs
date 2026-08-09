/**
 * @fileoverview content.js's reconnecting port to background.js. Owns
 * creating the chrome.runtime.connect port, reconnecting it when it dies,
 * and sending safely — content.js supplies what a message means
 * (onMessage) and what to do once a connection is live (onConnect).
 *
 * A port can die without content.js being re-injected: a bfcache restore
 * resumes the same script instance with its old, dead port (see the
 * pageshow listener below), and a service-worker restart kills the port
 * even without a navigation. connect() runs again in both cases so `port`
 * always ends up live; send() guards individual sends against the brief
 * window before a dead port is detected.
 */

(() => {
  'use strict';

  // Running the WebSocket in background.js (not here) bypasses the page's
  // CSP (Netflix blocks ws:// from content scripts via connect-src), and
  // the open port keeps the MV3 service worker alive for the tab's lifetime.
  /**
   * @param {{
   *   onMessage: (msg: any) => void,
   *   onConnect: (send: (msg: object) => void) => void,
   * }} deps
   * @returns {RvsBackgroundPort}
   */
  function createBackgroundPort({ onMessage, onConnect }) {
    /** @type {chrome.runtime.Port | null} */
    let port = null;

    /** @param {object} msg */
    function send(msg) {
      if (!port) {
        return;
      }
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
        // Extension context invalidated (e.g. reloaded/updated while this
        // page was open) — nothing left to reconnect to until the page reloads.
        console.error('[RVS] Failed to connect to background.js:', err);
        port = null;
        return;
      }

      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(connect);

      // Runs on every successful connect, first and reconnects alike, with
      // this module's own send() passed straight in (avoids the caller
      // needing this factory's own return value before it exists).
      onConnect(send);
    }

    connect();

    // A bfcache restore resumes this exact script instance with its old
    // port already dead — reconnect the moment the page is interactive
    // again, rather than waiting for the next send() to discover it.
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) {
        connect();
      }
    });

    return { send };
  }

  window.RVS = { ...window.RVS, createBackgroundPort };
})();
