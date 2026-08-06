// players.js — the two write-path adapters, loaded before content.js (same
// isolated world). Each owns its own anti-feedback lock timing so content.js just
// calls player.apply(msg) / player.isApplying(). Incoming msg.time already carries
// latency compensation (stamped in background.js); players only clamp it to the
// video duration.
//
// Exposed on window.RVS rather than relying on cross-script lexical scope, so the
// coupling to content.js stays explicit (factories receive their deps).

(() => {
  'use strict';

  // YouTube: write the <video> element directly.
  // deps.getVideo() returns a connected <video> (re-finding it if the SPA swapped
  // it out), or null when none exists yet.
  /**
   * @param {{ getVideo: () => HTMLVideoElement | null }} deps
   * @returns {RvsPlayer}
   */
  const createDirectPlayer = ({ getVideo }) => {
    let isApplying = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let resetTimer = null;
    // A command parked until the <video> exists.
    /** @type {{ msg: RvsSyncCommand, timer: ReturnType<typeof setTimeout> } | null} */
    let pending = null;

    // Resilient seek: waits for metadata if the element isn't ready yet.
    /**
     * @param {HTMLVideoElement} video
     * @param {number} targetTime
     */
    function seekVideo(video, targetTime) {
      try {
        if (video.readyState >= 1) {
          video.currentTime = targetTime;
        } else {
          video.addEventListener('loadedmetadata', () => {
            try { video.currentTime = targetTime; } catch (_) {}
          }, { once: true });
        }
      } catch (err) {
        console.warn('[RVS] Seek failed:', err);
      }
    }

    /** @param {RvsSyncCommand} msg */
    function apply(msg) {
      const video = getVideo();
      if (!video) {
        // Park and retry when the element appears (drained via onVideoReady).
        if (pending) clearTimeout(pending.timer);
        const timer = setTimeout(() => {
          pending = null;
          console.warn('[RVS] Sync command dropped: no video after 5s.');
        }, 5000);
        pending = { msg, timer };
        return;
      }

      isApplying = true;
      const { action } = msg;
      if (action === 'play') {
        seekVideo(video, Math.min(video.duration || Infinity, msg.time));
        video.play().catch((err) => console.error('[RVS] Play failed:', err));
      } else if (action === 'pause') {
        video.pause();
      } else if (action === 'seek') {
        seekVideo(video, Math.min(video.duration || Infinity, msg.time));
      } else if (action === 'rate') {
        video.playbackRate = msg.rate;
      }

      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => { isApplying = false; }, 250);
    }

    function onVideoReady() {
      if (!pending) return;
      const { msg, timer } = pending;
      pending = null;
      clearTimeout(timer);
      apply(msg);
    }

    return { apply, isApplying: () => isApplying, onVideoReady };
  };

  // Netflix: never touch the <video> (triggers M7375). Drive the official player
  // API via the main-world bridge — postMessage out and ack back. No video deps,
  // since the write path doesn't read the element and never parks (the bridge
  // waits for the player itself).
  /** @returns {RvsPlayer} */
  const createBridgePlayer = () => {
    let isApplying = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let resetTimer = null;
    let cmdSeq = 0;

    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;

      if (msg.__rvs === 'bridge-ready') {
        console.log('[RVS] Netflix bridge ready.');
      } else if (msg.__rvs === 'ack') {
        if (!msg.ok) console.warn('[RVS] Bridge command failed:', msg.reason);
        // Resume capture shortly after the bridge applied the command, so the
        // native events it produced (play/seeked/...) aren't re-broadcast.
        clearTimeout(resetTimer);
        resetTimer = setTimeout(() => { isApplying = false; }, 300);
      }
    });

    /** @param {RvsSyncCommand} msg */
    function apply(msg) {
      isApplying = true;
      // Safety net: resume capture even if no ack arrives (player never appeared).
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => { isApplying = false; }, 4500);

      /** @type {RvsBridgeCommand} */
      const cmd = { __rvs: 'cmd', id: ++cmdSeq, action: msg.action };
      if (msg.action === 'play' || msg.action === 'seek') {
        cmd.time = msg.time;
      } else if (msg.action === 'rate') {
        cmd.rate = msg.rate;
      }
      window.postMessage(cmd, '*');
    }

    return { apply, isApplying: () => isApplying, onVideoReady() {} };
  };

  window.RVS = { createDirectPlayer, createBridgePlayer };
})();
