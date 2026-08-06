// @ts-nocheck — not yet migrated to noImplicitAny; see CONTRIBUTION.md
// shared-utils.js — stateless utility functions shared between the popup
// realm (popup.html) and the content-script realm (manifest.json's
// content_scripts). Each realm gets its own copy of this script and its own
// window.RVS, so this shares source, not runtime state, between the two.
//
// Home for small, pure, no-state functions only — factories that return a
// stateful object (players.js, connection-state.js, background-port.js)
// stay in their own file each; this file is specifically for the "just a
// function, no state to own" tier, so it doesn't turn into a catch-all as
// more of these accumulate.

(() => {
  'use strict';

  // Exact match or proper subdomain — never a loose substring match, since
  // that would also fire on e.g. "netflix.com.evil.example". Used by
  // content.js for its own top-level isYouTube/isNetflix and by
  // getVideoId() classifying arbitrary URLs (including the peer's reported
  // URL, which arrives over the network); used by popup.js's
  // isSafeMediaUrl() before turning the peer's URL into a clickable link.
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
