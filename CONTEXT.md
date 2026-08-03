# Domain Glossary

Terms that name architectural concepts in this codebase, sharpened as they come up.

## Popup Channel

The popup's transport to the active tab's content script (`extension/popup-channel.js`). Owns `chrome.tabs.query`/`chrome.tabs.sendMessage` and the "no content script there" (`chrome.runtime.lastError`) detection, and owns the 1s `GET_STATUS` poll cadence internally via `watchStatus(callback)`. `popup.js` only ever calls `send(message, callback)` / `watchStatus(callback)` — it never touches `chrome.tabs` or `chrome.runtime.lastError` directly.

Introduced to give the popup↔content-script status exchange a single home: the transport had churned across three PRs (#33 push-based, #39 dual-transport fallback, #41 revert to polling) because "how do I talk to the content script" was repeated inline at every call site instead of living behind one interface. Deliberately polling-only — no push-mode adapter — since that's the only transport proven to work across engines (Chromium and Orion/iOS both support `chrome.tabs.sendMessage`; `chrome.tabs.connect` does not work reliably on Orion).

Scope is transport mechanics only — `content.js`'s domain logic (`applyConnect`/`applyDisconnect`-equivalent branches, the sessionStorage room-state helpers, the `GET_STATUS` response shape) stays in `content.js` and is unaffected.

## Tab Session

The background service worker's per-tab connection lifecycle (`extension/tab-session.js`, `createTabSession(tabId, { updateIcon })`), stored in `background.js`'s `tabStates: Map<tabId, TabSession>`. Owns the WebSocket to the signaling server, the port to that tab's content script, and the room-membership/latency-ping state behind one interface: `rebind(port)`, `disconnect(deadPort, lastErrorMessage)`, `handlePortMessage(msg)`, `getStatus()`. `background.js` never reaches into a session's WebSocket, port, or room state directly — only through these four calls. `updateIcon` is injected rather than called as a bare cross-file global (`background.js` and `tab-session.js` otherwise share one scope via `importScripts`), matching `players.js`'s `createDirectPlayer({ getVideo })` convention — every external dependency this module needs is an explicit parameter or return value, none of it reached for.

Introduced because a same-tab page navigation (any real reload, not an SPA-internal navigation like clicking a video from the YouTube homepage) disconnects the tab's current port — usually because the page became eligible for the back/forward cache (bfcache), which Chrome treats as a reason to sever extension ports even though the page may still be alive and merely frozen, not actually gone. `disconnect()` tells a bfcache-driven disconnect apart from a real one (via `chrome.runtime.lastError`'s message, matched by the standalone `isBfcacheDisconnectReason()`) and, when it isn't real, keeps the session alive so the next port for that tabId rebinds onto it instead of the session being torn down. Tearing it down was the actual bug: a fresh WebSocket reopening and rejoining the room raced the still-closing old socket against the signaling server's 2-peer room-slot check, and got spuriously rejected as "room full" — read by the user as a lost connection with a different room number, even on a same-origin navigation.

A Tab Session's in-memory state does not survive the service worker itself being terminated by Chrome (which can happen if every tab's port is briefly disconnected at once) — `content.js`'s `sessionStorage`-backed `resumeRoom` (see `CLAUDE.md`) is the fallback for that case, not made redundant by this module.

## Connection State

`content.js`'s local mirror of the popup-facing connection status (`extension/connection-state.js`, `createConnectionState()`, exposed on `window.RVS` alongside `players.js`'s factories). Owns `status`/`peersCount`/`oneWayLatency`/`peerMediaInfo` behind `connect()`, `disconnect()`, `handleState(msg)`, `handleLatencyUpdate(latency)`, `handleMediaInfo(msg)`, `handleError()`, `getSnapshot()` — `content.js` never reaches into that state directly, only through these calls.

Not the same thing as a **Tab Session** despite the name similarity: a Tab Session (background.js) owns the actual WebSocket and is the source of truth; Connection State is content.js's derived view of it, used only to answer the popup's `GET_STATUS` and to gate `shareMediaInfo`. It doesn't own the port, the room-join request, or `sessionStorage` — those stay `content.js`'s own job, orchestrated around calls into this module (e.g. `handleState()` returns `{ confirmedRoomId, isJustPaired }` rather than persisting the room or triggering a media-info share itself, so this module never needs `sessionStorage` or the player injected into it).

`lastSentMediaInfo` (the de-dupe cache for `shareMediaInfo`'s own broadcasts) is deliberately *not* part of this module — it's reset alongside connection state at the same call sites, but it's `main()`'s own "Now Watching" broadcast bookkeeping, not connection status.

`connection-state.js` merges into `window.RVS` (`window.RVS = { ...window.RVS, createConnectionState }`) rather than overwriting it like `players.js` does — the two now coexist in the same content-script realm (see `players.js`'s load-order note in `manifest.json`), so whichever loads second has to preserve what the first one set.
