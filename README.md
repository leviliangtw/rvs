# 🎬 Remote Video Synchronizer (RVS)

[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-Install-blue.svg?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/remote-video-synchronizer/iibemhaocbfpjmmdeihioookigedahne)
[![Chrome Extension](https://img.shields.io/badge/Chrome_Extension-Manifest_V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Signaling Server](https://img.shields.io/badge/Signaling_Server-Node.js_/_ws-green.svg)](https://github.com/websockets/ws)
[![License](https://img.shields.io/badge/License-Apache_2.0-orange.svg)](LICENSE)

A real-time **Chrome Extension & Signaling Server** that synchronizes video playback, seek times, and speed between remote users on **YouTube** and **Netflix**. Uses state-lock anti-feedback and latency-compensated seeking to keep playback in sync despite network delay.

> 📦 **Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/remote-video-synchronizer/iibemhaocbfpjmmdeihioookigedahne)** — no manual loading required.

---

## 🗺️ Architecture at a Glance

RVS has two components:

- **Chrome extension** ([`extension/`](extension/)) — injected into YouTube/Netflix
  tabs to capture local video events and apply remote sync commands.
- **Signaling server** ([`server.js`](server.js)) — a lightweight Node.js WebSocket
  relay that routes messages between exactly two peers per room.

The WebSocket is owned by the background service worker (not the content script),
and Netflix writes go through a MAIN-world bridge to avoid tamper detection. For
the full design, see the **[Implementation Plan](docs/implementation_plan.md)**.

---

## ✨ Features

- **Two-peer rooms** — each room holds a maximum of two peers.
- **Latency compensation** — `play`/`seek` targets are offset by the measured
  one-way delay.
- **State lock (anti-feedback)** — programmatic commands don't get re-broadcast
  back to the peer.
- **Netflix support without tamper detection** — a MAIN-world bridge drives
  Netflix's official player API instead of writing to the `<video>` element.
- **SPA resilience** — re-binds to the `<video>` element if the page replaces it.
- **"Now Watching" sharing** — see your peer's current video and click to join it.
- **Same-video gating** — sync pauses automatically when peers are on different
  videos, and resumes once they match.
- **Connect/Disconnect toggle** — Room ID generator, copy/paste shortcuts, and
  live status/peer-count/RTT readouts.

---

## 🚀 Getting Started

Run the full system locally in a few steps.

### 1. Prerequisites

Install [Node.js](https://nodejs.org/) (v16+).

### 2. Set up and start the signaling server

1. Clone the repository and move into it:
   ```bash
   git clone https://github.com/leviliangtw/rvs.git
   cd rvs
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the local server:
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

## 📚 Documentation

| Document | What's inside |
| :--- | :--- |
| [Implementation Plan](docs/implementation_plan.md) | System architecture, message flow, per-file design, sync mechanics, and the peer-sync sequence diagram. |
| [Deployment Plan](docs/deployment_plan.md) | Production deployment: TLS/WSS reverse proxy, systemd, and automated Chrome Web Store publishing. |
| [Contribution Guide](CONTRIBUTION.md) | Contributions welcome — branching, linting, and the version-bump release workflow. |
| [Domain Glossary](CONTEXT.md) | Vocabulary for this codebase's own architectural concepts. |
| [ADRs](docs/adr/) | Architecture decision records — load-bearing design decisions and why they were made. |
| [Privacy Policy](PRIVACY_POLICY.md) | What data the extension collects/transmits, and why. |
| [Terms of Service](TERMS_OF_SERVICE.md) | Terms governing use of the extension and signaling server. |

---

## 📄 License

This project is licensed under the Apache License 2.0 — see the [LICENSE](LICENSE)
file for details.
