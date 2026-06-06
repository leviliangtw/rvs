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
  const createDirectPlayer = ({ getVideo }) => {
    let applying = false;
    let resetTimer = null;
    let pending = null; // { msg, timer } — a command parked until the <video> exists

    // Resilient seek: waits for metadata if the element isn't ready yet.
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

      applying = true;
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
      resetTimer = setTimeout(() => { applying = false; }, 250);
    }

    function onVideoReady() {
      if (!pending) return;
      const { msg, timer } = pending;
      pending = null;
      clearTimeout(timer);
      apply(msg);
    }

    return { apply, isApplying: () => applying, onVideoReady };
  };

  // Netflix: never touch the <video> (triggers M7375). Drive the official player
  // API via the main-world bridge — postMessage out and ack back. No video deps,
  // since the write path doesn't read the element and never parks (the bridge
  // waits for the player itself).
  const createBridgePlayer = () => {
    let applying = false;
    let resetTimer = null;
    let cmdSeq = 0;

    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const d = event.data;
      if (!d || typeof d !== 'object') return;

      if (d.__rvs === 'bridge-ready') {
        console.log('[RVS] Netflix bridge ready.');
      } else if (d.__rvs === 'ack') {
        if (!d.ok) console.warn('[RVS] Bridge command failed:', d.reason);
        // Resume capture shortly after the bridge applied the command, so the
        // native events it produced (play/seeked/...) aren't re-broadcast.
        clearTimeout(resetTimer);
        resetTimer = setTimeout(() => { applying = false; }, 300);
      }
    });

    function apply(msg) {
      applying = true;
      // Safety net: resume capture even if no ack arrives (player never appeared).
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => { applying = false; }, 4500);

      const cmd = { __rvs: 'cmd', id: ++cmdSeq, action: msg.action };
      if (msg.action === 'play' || msg.action === 'seek') {
        cmd.time = msg.time;
      } else if (msg.action === 'rate') {
        cmd.rate = msg.rate;
      }
      window.postMessage(cmd, '*');
    }

    return { apply, isApplying: () => applying, onVideoReady() {} };
  };

  window.RVS = { createDirectPlayer, createBridgePlayer };
})();
