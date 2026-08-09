/**
 * @fileoverview content.js's local mirror of the popup-facing connection
 * status: is this tab connected, how many peers, the round-trip latency,
 * and what the peer is currently watching. Exposed on window.RVS (like
 * players.js) so content.js can reach it without shared lexical scope.
 *
 * Loaded after players.js in the same content-script world — merges into
 * window.RVS rather than overwriting it, since both files' factories now
 * coexist here.
 */

(() => {
  'use strict';

  // Doesn't own the port, the room-join request, or sessionStorage (those
  // stay content.js's job) — purely the state machine for "what should
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
      // module needs (`reported`-prefixed to avoid shadowing this module's
      // own status/peersCount). Returns the confirmed roomId to persist
      // (null unless this is an actual 'connected' transition) and whether
      // pairing just completed — the caller decides what to do with those.
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
