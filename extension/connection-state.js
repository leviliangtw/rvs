// connection-state.js — content.js's local mirror of the popup-facing
// connection status: is this tab connected, how many peers, the round-trip
// latency, and what the peer is currently watching. Exposed on window.RVS
// (same convention as players.js) so content.js can reach it without relying
// on shared lexical scope.
//
// Loaded after players.js in the same content-script world (see
// manifest.json) — merges into window.RVS rather than overwriting it, since
// both files' factories now coexist here (players.js still assigns directly,
// since it loads first and window.RVS doesn't exist yet at that point).

(() => {
  'use strict';

  // Doesn't own the port, the room-join request, or sessionStorage — those
  // stay content.js's job. This is purely the state machine for "what should
  // GET_STATUS report right now," driven by messages content.js hands it.
  /** @returns {RvsConnectionState} */
  function createConnectionState() {
    let status = 'Disconnected';
    let peersCount = 0;
    let oneWayLatency = 0;
    /** @type {{ title: string, url: string } | null} */
    let peerMediaInfo = null;

    function setToConnecting() {
      status = 'Connecting';
      peerMediaInfo = null;
    }

    // Shared by disconnect() and handleError() — both mean "forget everything,
    // this session isn't live."
    function resetToDisconnected() {
      status = 'Disconnected';
      peersCount = 0;
      oneWayLatency = 0;
      peerMediaInfo = null;
    }

    return {
      connect: setToConnecting,
      disconnect: resetToDisconnected,
      // Connection-level or server-reported error — same as disconnect().
      handleError: resetToDisconnected,

      // 'state' message from background, narrowed to just the fields this
      // module needs (not the whole wire packet — `reported`-prefixed to
      // stay distinct from this module's own status/peersCount, since
      // shadowing those with same-named params would silently write to the
      // param instead of the module's state). Returns the confirmed roomId
      // to persist (or null — only set on an actual 'connected' transition,
      // matching what this replaced) and whether this transition just
      // completed pairing — this module doesn't touch sessionStorage or the
      // player itself, the caller decides what to do with those.
      handleState({ status: reportedStatus, peersCount: reportedPeersCount, roomId: reportedRoomId }) {
        peersCount = reportedPeersCount;
        let confirmedRoomId = null;
        let isJustPaired = false;
        if (reportedStatus === 'connected') {
          status = 'Connected';
          confirmedRoomId = reportedRoomId || null;
          isJustPaired = peersCount === 2;
        } else if (reportedStatus === 'peer_disconnected') {
          // TODO: more robust handling of mid-session disconnects (e.g.
          // pause and alert, or even remove the peer count limit and just
          // alert?) — alert('Remote user has disconnected.');
          peersCount = 1;
          peerMediaInfo = null;
        }
        return { confirmedRoomId, isJustPaired };
      },

      handleLatencyUpdate(latency) {
        oneWayLatency = latency;
      },

      handleMediaInfo({ title, url }) {
        peerMediaInfo = url ? { title: title || url, url } : null;
      },

      getSnapshot() {
        return {
          status,
          peersCount,
          latency: peersCount === 2 ? oneWayLatency : null,
          peerMediaInfo,
        };
      },
    };
  }

  window.RVS = { ...window.RVS, createConnectionState };
})();
