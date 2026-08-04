// room-id.js — the random 6-character Room ID generator, shared between
// popup.js (the Generate button) and content.js (seeding a per-tab
// suggestion) — was previously defined verbatim in both. Loaded into both
// the popup realm (popup.html) and the content-script realm
// (manifest.json's content_scripts), so each gets its own copy of this
// script and its own window.RVS; this doesn't share runtime state between
// the two realms, just the one function's source.

(() => {
  'use strict';

  // Random 6-char Room ID (A-Z0-9).
  function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  window.RVS = { ...window.RVS, generateRoomId };
})();
