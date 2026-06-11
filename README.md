# 🎬 Remote Video Synchronizer (RVS)

[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-Install-blue.svg?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/remote-video-synchronizer/iibemhaocbfpjmmdeihioookigedahne)
[![Chrome Extension](https://img.shields.io/badge/Chrome_Extension-Manifest_V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Signaling Server](https://img.shields.io/badge/Signaling_Server-Node.js_/_ws-green.svg)](https://github.com/websockets/ws)
[![Security Audited](https://img.shields.io/badge/Security-Audited-brightgreen.svg)](#-security--safety-guidelines)
[![License](https://img.shields.io/badge/License-Apache_2.0-orange.svg)](LICENSE)

A premium, high-performance, real-time **Chrome Extension & Signaling Server** that synchronizes video playback, seek times, and speed between remote users on **YouTube** and **Netflix**. Engineered with **State Lock Synchronization** and **Latency-Compensated Seeking** to guarantee frame-accurate sync regardless of network delay.

> 📦 **Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/remote-video-synchronizer/iibemhaocbfpjmmdeihioookigedahne)** — no manual loading required.

---

## 🗺️ Architecture at a Glance

RVS has two components:

- **Chrome extension** (`extension/`) — injected into YouTube/Netflix tabs to
  capture local video events and apply remote sync commands.
- **Signaling server** (`server.js`) — a lightweight Node.js WebSocket relay that
  routes messages between exactly two peers per room.

The WebSocket is owned by the background service worker (not the content script),
and Netflix writes go through a MAIN-world bridge to avoid tamper detection. For
the full design — service-worker WebSocket ownership, the Netflix bridge, the
message flow, and a peer-sync sequence diagram — see the
**[Implementation Plan](docs/implementation_plan.md)**.

---

## ✨ Features

- **Two-peer rooms**: Each room holds a maximum of two peers, keeping bandwidth and
  synchronization simple and predictable.
- **Latency compensation**: A periodic ping/pong measures round-trip time; `play`
  and `seek` targets are offset by the estimated one-way delay so both players land
  at the same point.
- **State lock (anti-feedback)**: Programmatically applied commands are flagged so
  the resulting `play`/`pause`/`seeked` events aren't re-broadcast back to the peer.
- **Netflix support without tamper detection**: A MAIN-world bridge drives Netflix's
  official player API, avoiding the M7375 error caused by writing to the `<video>`
  element directly. YouTube uses the direct path.
- **SPA resilience**: A `MutationObserver` hooks into the `<video>` element once the
  single-page app injects it, and re-binds if it's replaced.
- **"Now Watching" sharing**: The popup shows your peer's current video as a title
  with a link; clicking it navigates your current tab to "join" what they're watching,
  and the session auto-rejoins after the page loads. Peer URLs are validated (http(s)
  YouTube/Netflix only) before linking.
- **Same-video gating**: Play/pause/seek/speed sync is suppressed when the two peers
  are on different videos (compared by canonical video ID), and resumes automatically
  once they're on the same one.
- **Connect/Disconnect toggle**: The popup connects or cleanly disconnects from a
  room, with a randomized Room ID generator, copy/paste shortcuts, and live status,
  peer-count, and RTT readouts.

---

## 📁 Repository Structure

| Path | Purpose |
| :--- | :--- |
| [`extension/`](extension/) | The packaged Chrome extension (Manifest V3) — popup, content script, service worker, and Netflix bridge. See the [per-file design](docs/implementation_plan.md#component-design). |
| [`server.js`](server.js) | Node.js WebSocket signaling server; relays between two peers per room. Reads `PORT`/`HOST` env vars. |
| [`docs/`](docs/) | Project documentation — see [Documentation](#-documentation) below. |
| [`CONTRIBUTION.md`](CONTRIBUTION.md) | Contributor workflow: branching, linting, and the version-bump release process. |
| [`task.md`](task.md) | Development milestones and verification checklist. |
| [`PRIVACY_POLICY.md`](PRIVACY_POLICY.md) | Privacy policy for the published extension. |

---

## 🚀 Getting Started

Run the full system locally in a few steps.

### 1. Prerequisites

Install [Node.js](https://nodejs.org/) (v16+).

### 2. Set up and start the signaling server

1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the local server:
   ```bash
   npm start
   ```
   The terminal will print:
   `Remote Video Synchronizer (RVS) Signaling Server running on ws://127.0.0.1:8080`

> For local development the extension must point at this server. Set
> `WS_SERVER_URL` in [`extension/config.js`](extension/config.js) to
> `ws://127.0.0.1:8080`. Production uses `wss://` (see the
> [Deployment Plan](docs/deployment_plan.md)).

### 3. Load the extension in Chrome

1. Open `chrome://extensions/`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `extension/` directory.

---

## 🎮 How to Test and Use

To verify synchronization between two parties (or test locally with side-by-side
tabs):

1. **Open two tabs** and navigate to the same YouTube or Netflix video in both.
2. **In Tab 1**, open the extension popup:
   - Click **Generate** to create a Room ID, then **Copy** it.
   - Click **Connect**. Status goes to `Connecting` and then `Connected`.
3. **In Tab 2**, open the extension popup:
   - Click **Paste** to fill in the Room ID.
   - Click **Connect**. Status shows `Connected` with `2 / 2` peers.
4. Play, pause, change playback speed, or scrub in either tab — the other follows.
5. Click **Disconnect** in either tab to leave the room cleanly.

---

## 🔒 Security & Safety Guidelines

- **No `innerHTML`**: DOM updates use `textContent` and `createElement`, avoiding a
  common XSS vector.
- **Local-only by default**: The signaling server binds to `127.0.0.1:8080` unless
  `HOST` is set, so it isn't exposed externally during local testing.
- **Graceful fallbacks**: If the browser blocks clipboard access, the popup falls
  back to a console warning and a user prompt instead of failing silently.

---

## 📚 Documentation

| Document | What's inside |
| :--- | :--- |
| [Implementation Plan](docs/implementation_plan.md) | System architecture, message flow, per-file design, sync mechanics, and the peer-sync sequence diagram. |
| [Deployment Plan](docs/deployment_plan.md) | Production deployment: TLS/WSS reverse proxy, systemd, and automated Chrome Web Store publishing. |
| [Contribution Guide](CONTRIBUTION.md) | Branching, linting, and the version-bump release workflow. |
| [Walkthrough](docs/walkthrough.md) | Annotated end-to-end verification run. |

---

## 🤝 Contributing

Contributions are welcome. Work on a `type/short-description` branch, run
`npm run lint`, and open a PR into `main`. **Only bump the extension version when
you intend to ship a release** — see [CONTRIBUTION.md](CONTRIBUTION.md) for the
complete workflow.

---

## 📄 License

This project is licensed under the Apache License 2.0 — see the [LICENSE](LICENSE)
file for details.
