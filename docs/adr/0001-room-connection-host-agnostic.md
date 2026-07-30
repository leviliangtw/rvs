# Room connection is host-agnostic; sync is YouTube/Netflix-only

Popup users can CONNECT/DISCONNECT/GET_STATUS from any page (not just
YouTube/Netflix) so a room can be joined — and its status queried — before
ever navigating to a shared video. Only the video-sync integration in
`content.js` (site adapter, write-path player, `<video>` DOM observer) is
gated to YouTube/Netflix; connecting elsewhere leaves the user "in the room"
with no sync applied, which is self-evident since there's simply no video on
screen to sync.

## Considered Options

- Keep the whole content script (including CONNECT/DISCONNECT/GET_STATUS)
  gated to YouTube/Netflix, and show "Unsupported Page" everywhere else, as
  before. Rejected because it blocks a legitimate flow: pre-connecting to a
  room (e.g. from a fresh tab) before navigating to the shared video.
- Surface the host-agnostic "in room, not syncing" state distinctly in the
  popup UI (e.g. a `syncSupported` flag on `GET_STATUS`). Rejected as
  unnecessary noise — the existing "Peer is watching" panel plus the simple
  fact that there's no video on the user's own screen already make the lack
  of sync self-evident.
