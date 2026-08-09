/**
 * @fileoverview The popup's transport to the active tab's content script.
 * Loaded before popup.js (like players.js -> content.js): an IIFE
 * exposing a factory on window.RVS, so popup.js only ever sees
 * send()/watchStatus(), never chrome.tabs.query/sendMessage or the
 * lastError-means-unsupported-page check directly.
 *
 * Merges into window.RVS (matching shared-utils.js) rather than
 * overwriting it, since both files populate it in this same popup realm.
 */

(() => {
  'use strict';

  const STATUS_POLL_INTERVAL_MS = 1000;

  /** @returns {RvsPopupChannel} */
  function createPopupChannel() {
    // Send one message to the active tab's content script. Normalizes "no
    // active tab" and "no content script there" (chrome.runtime.lastError)
    // to a single callback(null), so callers never touch either directly.
    /**
     * @param {object} msg
     * @param {(response: any) => void} callback
     */
    function send(msg, callback) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || tabs.length === 0 || tabs[0].id == null) {
          callback(null);
          return;
        }

        chrome.tabs.sendMessage(tabs[0].id, msg, (response) => {
          if (chrome.runtime.lastError) {
            void chrome.runtime.lastError; // clear "unchecked lastError" warning
            callback(null);
            return;
          }
          callback(response);
        });
      });
    }

    // Poll GET_STATUS immediately and every STATUS_POLL_INTERVAL_MS thereafter.
    // callback(response) each tick, or callback(null) on an unsupported page.
    // Returns stop() to clear the interval.
    /** @param {(response: any) => void} callback */
    function watchStatus(callback) {
      function tick() {
        send({ action: 'GET_STATUS' }, callback);
      }
      tick();
      const intervalId = setInterval(tick, STATUS_POLL_INTERVAL_MS);
      return () => clearInterval(intervalId);
    }

    return { send, watchStatus };
  }

  window.RVS = { ...window.RVS, createPopupChannel };
})();
