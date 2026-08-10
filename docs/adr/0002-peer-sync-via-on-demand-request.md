# Join Peer fetches live state on demand, instead of extending periodic media_info

**Join Peer** (clicking the peer's "Now Watching" title) needs the peer's current
playback position and play/pause state, which nothing in the wire protocol
carried before — `media_info` only ever held `title`/`url` for the popup's
display panel. We send a new no-payload `request_sync` packet on demand and
have the peer reply with its live state using the *existing* `play`/`pause`/`rate`
packet shapes, rather than adding `time`/`isPlaying`/`capturedAt` fields to the
periodic `media_info` broadcast and reconstructing position client-side via
extrapolation.

On-demand wins on both counts that matter here: freshness (no staleness from
the 4s re-share interval) and cost (reusing `play`/`pause`/`rate` means the
requesting side's `apply()` needs zero new code to consume the reply, and it
inherits `background.js`'s existing latency compensation for free — extending
`media_info` would have required writing and maintaining that extrapolation
math ourselves).

## Considered Options

- Extend `media_info` with `time`/`isPlaying`/`capturedAt`, extrapolating the
  peer's current position client-side from the last snapshot's age. Rejected:
  duplicates latency/staleness handling `background.js` already does for
  `play`/`seek`, and still lags by up to the 4s re-share interval.
