/**
 * @fileoverview The YouTube/Netflix-only half of content.js's job:
 * discovering the <video> element, driving the write-path player, and
 * broadcasting "Now Watching" media info. Loaded before content.js (same
 * isolated world), which only calls createVideoIntegration() and holds
 * the single object it returns.
 *
 * Exposed on window.RVS (matching background-port.js/players.js), merged
 * in rather than overwritten since other files populate it too.
 */

(() => {
  'use strict';

  // deps are narrowed to exactly what this module needs, not the whole
  // connectionState/backgroundPort objects content.js holds, so each can
  // be stubbed independently.
  /**
   * @param {{
   *   isNetflix: boolean,
   *   getSnapshot: () => RvsConnectionSnapshot,
   *   send: (msg: object) => void,
   *   isDifferentVideoFromPeer: () => boolean,
   * }} deps
   * @returns {RvsVideoIntegration}
   */
  function createVideoIntegration({ isNetflix, getSnapshot, send, isDifferentVideoFromPeer }) {

    // Site adapter — the only YouTube/Netflix difference on the READ/metadata
    // side. Picked once so the rest of this function is site-agnostic.
    function createSiteAdapter() {
      if (isNetflix) {
        return {
          isWatchPage: () => location.pathname.startsWith('/watch'),
          // Best-effort title from the page DOM (content scripts share the DOM).
          getTitle() {
            const el = document.querySelector('[data-uia="video-title"]');
            let title = el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
            if (!title) {
              title = document.title.replace(/\s*-\s*Netflix\s*$/i, '').trim();
            }
            return title;
          },
        };
      }
      return {
        isWatchPage: () => location.pathname === '/watch' || location.pathname.startsWith('/shorts/'),
        getTitle() {
          const el = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.ytd-watch-metadata');
          let title = el ? el.textContent.trim() : '';
          if (!title) {
            title = document.title.replace(/\s*-\s*YouTube\s*$/i, '').trim();
          }
          return title;
        },
      };
    }
    const site = createSiteAdapter();

    /** @type {HTMLVideoElement | null} */
    let videoElement = null;
    let isReadListenersAttached = false;

    // Broadcast-dedup cache (the last { url, title } shared) — private to
    // shareMediaInfo below, reset via forgetSharedMedia().
    /** @type {{ url: string, title: string } | null} */
    let lastSentMediaInfo = null;

    // Write path is fully encapsulated per site (see players.js): YouTube
    // writes the <video> directly; Netflix drives the official API via the
    // main-world bridge (direct writes there trigger error M7375).
    const player = isNetflix
      ? window.RVS.createBridgePlayer()
      : window.RVS.createDirectPlayer({ getVideo: ensureBoundVideo });

    // Best-effort local media, or null when not on a watch page. Falls back to the URL.
    function getLocalMedia() {
      if (!site.isWatchPage()) {
        return null;
      }
      const url = location.href;
      const title = site.getTitle();
      return { title: title || url, url };
    }

    /** @param {HTMLVideoElement} video */
    function attachReadListeners(video) {
      if (isReadListenersAttached) {
        return;
      }

      console.log('[RVS] Video element found, listeners attached.');

      // Don't broadcast local actions while the player is applying a remote
      // command (anti-feedback) or while the peer is watching a different video.
      const shouldSkipReadBroadcast = () => player.isApplying() || isDifferentVideoFromPeer();

      video.addEventListener('play', () => {
        if (shouldSkipReadBroadcast()) {
          return;
        }
        send({ action: 'play', time: video.currentTime });
      });

      video.addEventListener('pause', () => {
        if (shouldSkipReadBroadcast()) {
          return;
        }
        send({ action: 'pause', time: video.currentTime });
      });

      video.addEventListener('seeked', () => {
        if (shouldSkipReadBroadcast()) {
          return;
        }
        send({ action: 'seek', time: video.currentTime });
      });

      video.addEventListener('ratechange', () => {
        if (shouldSkipReadBroadcast()) {
          return;
        }
        send({ action: 'rate', rate: video.playbackRate });
      });

      isReadListenersAttached = true;
    }

    function discoverVideo() {
      const video = document.querySelector('video');
      if (!video) {
        return;
      }

      videoElement = video;
      attachReadListeners(video);

      // A new <video> usually means the SPA navigated to a different title — share it.
      shareMediaInfo(false);

      // Drain a command the player parked while waiting for the element (direct
      // path; no-op on Netflix, which never parks).
      player.onVideoReady();
    }

    // Re-discover when the SPA adds or swaps the <video> element (Netflix
    // replaces it on episode change) — staying bound to a detached element
    // left READ listeners firing on nothing. Resets isReadListenersAttached
    // too, or attachReadListeners() would see stale listeners as already
    // attached and skip the new element.
    function rediscoverVideo() {
      isReadListenersAttached = false;
      videoElement = null;
      discoverVideo();
    }

    // Backs the direct (YouTube) player: returns the bound <video>
    // (re-discovering it if the SPA swapped it out), or null if none
    // exists yet. Injected into createDirectPlayer to avoid an implicit
    // dependency on this module's state.
    function ensureBoundVideo() {
      if (videoElement && !videoElement.isConnected) {
        rediscoverVideo();
      }
      return videoElement || document.querySelector('video');
    }

    // Broadcast the local video to the peer, guarded to only emit when
    // paired (background also drops media_info unless two peers are
    // present). force=true re-sends even if nothing changed (e.g. right
    // after pairing). Plain function declaration, not const — hoisting
    // lets discoverVideo() above call it regardless of textual order.
    /** @param {boolean} force */
    function shareMediaInfo(force) {
      const { status, peersCount } = getSnapshot();
      if (status !== 'Connected' || peersCount !== 2) {
        return;
      }
      const media = getLocalMedia();
      if (!media) {
        return;
      }
      // De-dupe on title *and* url, not url alone: right after a Netflix
      // episode change the title isn't in the DOM yet (getTitle() falls
      // back to "Netflix"), so url-only keying would latch that stale
      // title. The periodic re-share below corrects it once the title
      // settles.
      const isUnchanged = lastSentMediaInfo
        && lastSentMediaInfo.url === media.url
        && lastSentMediaInfo.title === media.title;
      if (!force && isUnchanged) {
        return;
      }
      lastSentMediaInfo = media;
      send({ action: 'media_info', title: media.title, url: media.url });
    }

    // Re-share periodically so the peer follows SPA route changes that reuse the
    // same <video>, and titles that settle a beat after the URL.
    setInterval(() => shareMediaInfo(false), 4000);

    // The SPA injects/replaces the <video> ~1-2s after load, so we observe the
    // DOM rather than assume it's present yet. Reads stay on the <video> element
    // on both sites — only writes go through the bridge on Netflix.
    discoverVideo();

    const videoObserver = new MutationObserver(() => {
      const current = document.querySelector('video');
      if (current && current !== videoElement) {
        rediscoverVideo();
      }
    });
    videoObserver.observe(document.documentElement, { childList: true, subtree: true });

    return {
      // Ignoring remote commands while the peer is on a different video
      // lives here, not in the caller, so content.js never needs to
      // remember the rule.
      /** @param {RvsSyncCommand} msg */
      apply(msg) {
        if (isDifferentVideoFromPeer()) {
          return;
        }
        player.apply(msg);
      },
      shareMediaInfo,
      forgetSharedMedia() {
        lastSentMediaInfo = null;
      },
    };
  }

  window.RVS = { ...window.RVS, createVideoIntegration };
})();
