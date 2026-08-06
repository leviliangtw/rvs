# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Remote Video Synchronizer (RVS) is a two-component system:
1. **Chrome Extension** (`extension/`) — injects into YouTube/Netflix tabs to intercept video events and apply remote sync commands
2. **Signaling Server** (`server.js`) — a lightweight Node.js WebSocket relay that routes sync messages between exactly 2 peers per room

## Commands

```bash
npm install       # Install ws dependency
npm start         # Start local signaling server at ws://127.0.0.1:8080

# Package extension for Chrome Web Store
zip -r rvs-extension.zip extension/
```

There is no test suite. Linting and type-checking are configured:

```bash
npm run lint                          # ESLint over server.js + extension/
npx tsc -p jsconfig.json --noEmit     # TypeScript checkJs (JSDoc/ambient types)
```

## Contribution Workflow

Work on a `type/short-description` branch and open a PR into `main` — never push
to `main` directly. **One commit per PR:** squash/amend follow-up changes so each
merged PR lands as a single commit. Run `npm run lint` before pushing. Only bump
`extension/manifest.json` `version` in a PR you intend to ship (it triggers the
Chrome Web Store publish). See [CONTRIBUTION.md](CONTRIBUTION.md) for full detail.

## Architecture

### Message Flow

```
popup.js ─chrome.tabs.sendMessage─> content.js ─port─> background.js ─WebSocket─> server.js ─> (peer) background.js ─port─> content.js
```

- `popup.js` talks to `content.js` through the **Popup Channel** (`popup-channel.js`, loaded before `popup.js` in `popup.html`): `channel.send(message, callback)` wraps `chrome.tabs.query`/`chrome.tabs.sendMessage` and normalizes "no content script there" (`chrome.runtime.lastError`) to `callback(null)`, and `channel.watchStatus(callback)` owns the 1s `GET_STATUS` poll internally, so `popup.js` only ever reasons about `send`/`watchStatus` — never `chrome.tabs` or `lastError` directly. Actions: `CONNECT`, `DISCONNECT`, `GET_STATUS`.
- `content.js` reaches `background.js` through a **Background Port** (`background-port.js`, `createBackgroundPort({ onMessage, onConnect })`; see `CONTEXT.md`) wrapping a long-lived `chrome.runtime.connect` port (name `rvs-port`). It captures local video events and forwards them via `send(msg)`, and applies remote commands received through the `onMessage` callback. The module reconnects on its own — a bfcache restore or a service-worker restart can kill the port without `content.js` being re-injected — so `content.js` only supplies what a message means and what to do once a connection is live, never the port itself.
- The content-script bundle is **five files**, injected in order: `players.js` → `shared-utils.js` → `connection-state.js` → `background-port.js` → `content.js` (same isolated world). `players.js` exposes the two **write-path player adapters** on `window.RVS` — a direct player (YouTube) and a bridge player (Netflix). `content.js` picks one at startup based on the host and just calls `player.apply(msg)` / `player.isApplying()`. The direct player receives a `getVideo` callback (dependency injection) because it needs `content.js`'s bound `<video>`; the bridge player needs no DOM access, so it takes no deps. Site-specific READ/metadata differences (watch-page test, title scraping) live behind a `site` adapter picked the same way, so the rest of `content.js` is site-agnostic. `shared-utils.js` is also loaded into `popup.html` — see the note below.
- **No `host_permissions`, and `content_scripts.matches` is `<all_urls>`** for the content-script bundle and `netflix-bridge.js` alike — some corporate/sandboxed Chrome deployments block extensions that declare explicit host permissions for specific domains (e.g. `youtube.com`/`netflix.com`), which silently stops the content script from ever being injected there. Since the manifest no longer confines injection, `content.js` and `netflix-bridge.js` each gate on a hostname check at the top (exact match or proper subdomain, not a loose `.includes()`) and no-op entirely off YouTube/Netflix. `content.js`'s check goes through `shared-utils.js` below; `netflix-bridge.js` (MAIN world — see below) can't share `window.RVS` with the isolated world, so it keeps its own identical-logic inline check.
- `shared-utils.js` (`isHost(hostname, domain)`, `generateRoomId()`) is the one file loaded into **both** realms — `popup.html` (after `popup-channel.js`) and the content-script bundle (after `players.js`) — home for small, pure, no-state functions needed in both places: `popup.js`'s `isSafeMediaUrl()` and `content.js`'s `isHost()`/`getVideoId()` need the identical subdomain-safe domain check, and the popup's Generate button and `content.js`'s per-tab suggestion both need the same random-6-character logic. Factories that return a stateful object (`players.js`, `connection-state.js`, `background-port.js`) stay in their own file each — this file is specifically for the stateless tier, so it doesn't become a catch-all as more of these accumulate. Every file that populates `window.RVS` in either realm merges into it (`window.RVS = { ...window.RVS, x }`) rather than overwriting, so none of them depend on load order.
- **`background.js` owns the WebSocket**, via a **Tab Session** per tab (`tab-session.js`, `createTabSession(tabId)`, loaded through `importScripts`; see `CONTEXT.md`). `background.js` holds `tabStates: Map<tabId, TabSession>` and only ever calls a session's `rebind(port)` / `disconnect(deadPort, lastErrorMessage)` / `handlePortMessage(msg)` / `getStatus()` — the WebSocket, the port, and the room/latency state are private to the session. The WebSocket lives here — **not** in `content.js` — because Netflix's page CSP (`connect-src`) blocks `wss://` connections initiated from a content script. The service worker context is exempt from page CSP, and the open port keeps the worker alive for the tab's lifetime. A same-tab page navigation disconnects that port (often because the page became back/forward-cache eligible, not because it's actually gone), so `disconnect()` tells that apart from a real disconnect and keeps the session alive for the next port to rebind onto, instead of reopening the WebSocket and racing the server's 2-peer room check. `background.js` also renders the colored toolbar icon (red/yellow/green) via `OffscreenCanvas` (`updateIcon`, called from both files).

### Netflix Player Control (`netflix-bridge.js`)

Writing `video.currentTime` / `.play()` / `.pause()` directly on Netflix triggers tamper detection (**error M7375**) and tears down the player. So on Netflix, writes do **not** touch the `<video>` element:

- `netflix-bridge.js` is injected into the page's **MAIN world** (manifest `"world": "MAIN"`, Netflix only) so it can reach `window.netflix.appContext.state.playerApp.getAPI().videoPlayer`, which is invisible to the isolated content-script world.
- The **bridge player** (`players.js`, used on Netflix) posts commands to the bridge via `window.postMessage` (`{ __rvs: 'cmd', ... }`); the bridge drives the official player API (`player.play/pause/seek/setPlaybackRate`) and acks back (`{ __rvs: 'ack', ok, reason }`). The bridge player also listens for those acks (and the initial `bridge-ready`).
- **Reads are unchanged** — native `play`/`pause`/`seeked`/`ratechange` events on the `<video>` element fire regardless of who drives the player, so `content.js` still captures local actions by listening on the element on both sites. On Netflix the `<video>` is effectively read-only.
- **YouTube uses the direct player** (`players.js`), which writes `video.currentTime` / `video.play()` directly — fine there.
- `content.js` finds the `<video>` via a `MutationObserver` (the SPA injects it ~1–2s after load) and hands it to the direct player through the injected `getVideo` callback; commands arriving before the element exists are parked inside the direct player and drained when it appears (direct path only).

- `server.js` holds rooms in-memory as a `Map<roomId, WebSocket[]>`, max 2 peers per room, and blindly relays all non-`join` packets to the other peer

### Sync Packet Types

All packets are JSON. Client-originated packets:
- `{ action: 'join', room: string }` — sent on connect
- `{ action: 'play'|'pause'|'seek', time: number }` — video events
- `{ action: 'rate', rate: number }` — playback speed change
- `{ action: 'media_info', title: string, url: string }` — current video for the "Now Watching" panel (sent on pairing and on navigation; relayed peer-to-peer like any other packet)
- `{ action: 'p2p_ping', timestamp: number }` — latency probe (sent every 5s when 2 peers present)
- `{ action: 'p2p_pong', timestamp: number }` — echoed back by receiver

Server-originated packets (relayed by `background.js` to the content-script port; `background.js` also emits `{ action: 'latency_update', latency }` to the port after each `p2p_pong`):
- `{ action: 'state', status: 'connected'|'peer_disconnected', peersCount: number }`
- `{ action: 'error', message: string }`

### State Lock (Anti-Feedback)

Each player adapter (`players.js`) owns an internal `isApplying` flag so the programmatic event it produces isn't re-broadcast to the peer: before applying a remote command it sets the flag, and `content.js`'s event listeners skip broadcasting while `player.isApplying()` is true. The direct (YouTube) player clears the flag 250ms after applying via `setTimeout`. The bridge (Netflix) player clears it ~300ms after the bridge's `ack` arrives (with a 4.5s safety-net timeout), since the bridge applies the command asynchronously.

### Latency Compensation

One-way latency is estimated as `RTT / 2` in `background.js`. For incoming `play` and `seek` packets, `background.js` stamps the compensation onto `time` (`data.time += oneWayLatency / 1000`) before forwarding to the content-script port, so the players apply the timestamp verbatim (clamping only to the video duration). Centralizing it where latency is measured keeps both player adapters free of timing math.

## Key Configuration

**`extension/config.js`** — the single file to change for deployment:
```js
const WS_SERVER_URL = 'wss://your-domain.com'; // must be wss:// for YouTube/Netflix (HTTPS pages block ws://)
```

**Server env vars:**
- `PORT` — default `8080`
- `HOST` — default `127.0.0.1` (set to `0.0.0.0` for production)

## Loading the Extension Locally

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` directory

## Production Deployment

See `docs/deployment_plan.md` for full steps. Key constraint: YouTube and Netflix are HTTPS, so Chrome blocks `ws://` — a TLS reverse proxy (Caddy or Nginx) terminating `wss://` is required. The server itself does not handle TLS.

Avoid serverless platforms (Vercel, Lambda, Cloudflare Workers) — they don't support persistent WebSocket connections.

## Agent skills

### Issue tracker

Issues and PRDs live as GitHub issues in this repo; skills use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout — `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
