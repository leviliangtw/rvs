// netflix-bridge.js — runs in the page's MAIN world (see manifest "world": "MAIN").
//
// Netflix's player owns the <video> element through an internal state machine.
// Writing video.currentTime / .play() / .pause() directly from a content script
// triggers Netflix tamper detection (error M7375) and tears down the player.
//
// This bridge instead drives playback through Netflix's official internal player
// API — the same approach Teleparty uses. It lives in the MAIN world because the
// API hangs off window.netflix, which is invisible to the isolated content script.
// Commands arrive via window.postMessage from content.js; results are acked back.

(() => {
  'use strict';

  /**
   * The command envelope players.js's bridge player posts via
   * window.postMessage. `action` matches RvsSyncCommand's union
   * (globals.d.ts); __rvs/id are the postMessage envelope, not part of that
   * shared shape, so this is its own local typedef rather than reusing it.
   * @typedef {object} RvsBridgeCommand
   * @property {'cmd'} __rvs
   * @property {number} id
   * @property {'play' | 'pause' | 'seek' | 'rate'} action
   * @property {number} [time]
   * @property {number} [rate]
   */

  // Injected on <all_urls> (see manifest — no host_permissions, so corporate
  // sandbox/DLP policies blocking an explicit netflix.com host grant don't stop
  // the bridge from loading at all); this hostname check is what actually
  // confines it to Netflix, so it must not be a loose substring match — that
  // would also fire on e.g. "netflix.com.evil.example".
  const hostname = window.location.hostname;
  const isNetflix = hostname === 'netflix.com' || hostname.endsWith('.netflix.com');
  if (!isNetflix) return;

  // Resolve the active watch-session player object, or null if not ready.
  function getPlayer() {
    try {
      const api = /** @type {any} */ (window).netflix.appContext.state.playerApp.getAPI();
      const vp = api.videoPlayer;
      const sessionIds = vp.getAllPlayerSessionIds() || [];
      // Prefer the main 'watch' session over preview/billboard sessions.
      // Netflix's internal session-id shape is undocumented — kept as `any`
      // like the `api` cast above, rather than guessing a fake precise type.
      const sessionId = sessionIds.find((/** @type {any} */ id) => String(id).includes('watch')) || sessionIds[0];
      if (!sessionId) return null;
      return vp.getVideoPlayerBySessionId(sessionId) || null;
    } catch (_) {
      return null;
    }
  }

  // Poll for the player up to timeoutMs (it appears a beat after navigation).
  /** @param {number} timeoutMs */
  function withPlayer(timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const player = getPlayer();
        if (player) return resolve(player);
        if (Date.now() - start >= timeoutMs) return resolve(null);
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  /**
   * @param {number} id
   * @param {boolean} ok
   * @param {string} [reason]
   */
  function ack(id, ok, reason) {
    window.postMessage({ __rvs: 'ack', id, ok, reason }, '*');
  }

  /** @param {RvsBridgeCommand} cmd */
  async function handleCommand(cmd) {
    const player = await withPlayer(4000);
    if (!player) {
      ack(cmd.id, false, 'no-player');
      return;
    }

    try {
      const toMs = (/** @type {number} */ sec) => {
        let ms = Math.max(0, Math.round(sec * 1000));
        if (typeof player.getDuration === 'function') {
          const dur = player.getDuration();
          if (dur > 0) ms = Math.min(ms, dur);
        }
        return ms;
      };

      switch (cmd.action) {
        case 'play':
          if (typeof cmd.time === 'number') player.seek(toMs(cmd.time));
          player.play();
          break;
        case 'pause':
          player.pause();
          break;
        case 'seek':
          player.seek(toMs(cmd.time));
          break;
        case 'rate':
          // Netflix only accepts a fixed set: 0.5 / 0.75 / 1 / 1.25 / 1.5
          if (typeof player.setPlaybackRate === 'function') {
            player.setPlaybackRate(cmd.rate);
          } else {
            ack(cmd.id, false, 'rate-unsupported');
            return;
          }
          break;
        default:
          ack(cmd.id, false, 'unknown-action');
          return;
      }
      ack(cmd.id, true);
    } catch (e) {
      ack(cmd.id, false, String((e && e.message) || e));
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const cmd = event.data;
    if (!cmd || cmd.__rvs !== 'cmd') return;
    handleCommand(cmd);
  });

  window.postMessage({ __rvs: 'bridge-ready' }, '*');
  console.log('[RVS Bridge] Netflix main-world bridge loaded.');
})();
