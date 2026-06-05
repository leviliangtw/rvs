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

There is no test suite or linter configured.

## Architecture

### Message Flow

```
popup.js ─chrome.tabs.sendMessage─> content.js ─port─> background.js ─WebSocket─> server.js ─> (peer) background.js ─port─> content.js
```

- `popup.js` communicates with `content.js` via `chrome.runtime` messaging (actions: `CONNECT`, `GET_STATUS`)
- `content.js` opens a long-lived `chrome.runtime.connect` port (name `rvs-sync`) to `background.js`. It captures local video events and forwards them over the port, and applies remote commands received over the port.
- **`background.js` owns the WebSocket.** It holds per-tab state in a `Map<tabId, state>`, connects to `WS_SERVER_URL` (from `config.js`, loaded via `importScripts`), runs the latency ping loop, and relays sync packets between the port and the server. The WebSocket lives here — **not** in `content.js` — because Netflix's page CSP (`connect-src`) blocks `wss://` connections initiated from a content script. The service worker context is exempt from page CSP, and the open port keeps the worker alive for the tab's lifetime. `background.js` also renders the colored toolbar icon (red/yellow/green) via `OffscreenCanvas`.

### Netflix Player Control (`netflix-bridge.js`)

Writing `video.currentTime` / `.play()` / `.pause()` directly on Netflix triggers tamper detection (**error M7375**) and tears down the player. So on Netflix, writes do **not** touch the `<video>` element:

- `netflix-bridge.js` is injected into the page's **MAIN world** (manifest `"world": "MAIN"`, Netflix only) so it can reach `window.netflix.appContext.state.playerApp.getAPI().videoPlayer`, which is invisible to the isolated content-script world.
- `content.js` (Netflix) posts commands to the bridge via `window.postMessage` (`{ __rvs: 'cmd', ... }`); the bridge drives the official player API (`player.play/pause/seek/setPlaybackRate`) and acks back (`{ __rvs: 'ack', ok, reason }`).
- **Reads are unchanged** — native `play`/`pause`/`seeked`/`ratechange` events on the `<video>` element fire regardless of who drives the player, so `content.js` still captures local actions by listening on the element on both sites.
- **YouTube still uses the direct path** in `content.js` (`video.currentTime`, `video.play()`), which works fine there.
- `content.js` finds the `<video>` via a `MutationObserver` (the SPA injects it ~1–2s after load); commands arriving before the element exists are parked and drained when it appears (direct path only).

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

`content.js` sets `ignoreSyncEvents = true` before applying a remote command to prevent re-broadcasting the programmatic event back to the peer. On the YouTube/direct path it's released after 250ms via `setTimeout`. On the Netflix/bridge path it's released ~300ms after the bridge's `ack` arrives (with a 4.5s safety-net timeout), since the bridge applies the command asynchronously.

### Latency Compensation

One-way latency is estimated as `RTT / 2`. For `play` and `seek` actions, the receiver seeks to `data.time + oneWayLatency / 1000` so playback aligns despite transmission delay.

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
