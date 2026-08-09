/**
 * @fileoverview Stateless utility functions shared between the popup
 * realm (popup.html) and the content-script realm (manifest.json's
 * content_scripts). Each realm gets its own copy and its own window.RVS,
 * so this shares source, not runtime state.
 *
 * Home for small, pure, no-state functions only — stateful factories
 * (players.js, connection-state.js, background-port.js) stay in their
 * own file, so this one doesn't become a catch-all.
 */

(() => {
  'use strict';

  // Exact match or proper subdomain — never a loose substring match, since
  // that would also fire on "netflix.com.evil.example". Used by content.js
  // (isYouTube/isNetflix, getVideoId() on URLs including the peer's) and
  // by popup.js's isSafeMediaUrl() before making a link clickable.
  /**
   * @param {string} hostname
   * @param {string} domain
   * @returns {boolean}
   */
  function isHost(hostname, domain) {
    return hostname === domain || hostname.endsWith('.' + domain);
  }

  // Random 6-char Room ID (A-Z0-9). Used by popup.js's Generate button and
  // by content.js to seed a stable per-tab suggestion.
  function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  window.RVS = { ...window.RVS, isHost, generateRoomId };
})();
