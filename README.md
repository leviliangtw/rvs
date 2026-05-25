# 🎬 Remote Video Synchronizer (RVS)

[![Chrome Extension](https://img.shields.io/badge/Chrome_Extension-Manifest_V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Signaling Server](https://img.shields.io/badge/Signaling_Server-Node.js_/_ws-green.svg)](https://github.com/websockets/ws)
[![Security Audited](https://img.shields.io/badge/Security-Audited-brightgreen.svg)](#-security--safety)
[![License](https://img.shields.io/badge/License-MIT-orange.svg)](LICENSE)

A premium, high-performance, real-time **Chrome Extension & Signaling Server** that synchronizes video playback, seek times, and speed between remote users on **YouTube** and **Netflix**. Engineered with **State Lock Synchronization** and **Latency-Compensated Seeking** to guarantee frame-accurate sync regardless of network delay.

---

## 🗺️ System Architecture

The following diagram illustrates how the content scripts embedded in the browser tabs communicate via the WebSocket signaling server, manage peer states, and synchronize video operations:

```mermaid
sequenceDiagram
    autonumber
    actor PeerA as Peer A (YouTube/Netflix)
    participant Server as Signaling Server (Node.js/ws)
    actor PeerB as Peer B (YouTube/Netflix)

    Note over PeerA, Server: Connecting to Room (Max 2 Peers)
    PeerA->>Server: Connect to Room "SYNC123"
    Server-->>PeerA: Connected (1/2 Peers)
    PeerB->>Server: Connect to Room "SYNC123"
    Server-->>PeerB: Connected (2/2 Peers)
    Server-->>PeerA: Peer Joined (2/2 Peers)

    Note over PeerA, PeerB: Continuous Latency Tracking (Every 5s)
    PeerA->>Server: Ping Message (t1)
    Server->>PeerB: Ping Message Forwarded
    PeerB->>Server: Pong Response
    Server->>PeerA: Pong Forwarded (t2)
    Note over PeerA: Calculate Latency:<br/>RTT = t2 - t1<br/>One-Way Delay = RTT / 2

    Note over PeerA, PeerB: Synchronizing Video Action (e.g. Play/Pause/Seek)
    PeerA->>PeerA: User triggers Seek to 01:30:00
    Note over PeerA: Lock Event Handlers (ignoreSyncEvents)
    PeerA->>Server: Send "seek" (time = 90.0, timestamp)
    Server->>PeerB: Forward "seek" (time = 90.0)
    Note over PeerB: Lock Event Handlers (ignoreSyncEvents)
    Note over PeerB: Apply Latency Compensation:<br/>Target Seek Time = 90.0 + OneWayDelay
    PeerB->>PeerB: Seek video element to Target Seek Time
    Note over PeerB: Unlock Event Handlers
    Note over PeerA: Unlock Event Handlers
```

---

## ✨ Features

- **Double-Peer Rooms**: Enforces a strict **maximum of 2 peers per room** to optimize bandwidth and maintain high-fidelity synchronization.
- **Latency Compensation**: Real-time RTT measurements automatically offset playback triggers and seeks by the calculated one-way transmission latency, ensuring frame-perfect alignment.
- **State-Locking**: Anti-feedback loop protection blocks cascading recursive synchronization messages.
- **SPA Resiliency (Dynamic DOM Discovery)**: Proactively searches and auto-hooks into dynamic `<video>` elements, fully supporting Single Page Applications (SPAs) like YouTube and Netflix.
- **Micro-Animations & Fluent UI**: Features a sleek, modern, dark-themed Chrome Extension popup equipped with:
  - **Dynamic Room ID Generator**: Click to generate secure, randomized room codes.
  - **One-Click Clipboard Actions**: Effortlessly copy room codes or paste them from your clipboard.
  - **Real-Time Diagnostics**: Live connection indicators, active peer counters, and network RTT latency monitors.

---

## 📁 Repository Structure

| File / Folder | Purpose |
| :--- | :--- |
| **`extension/`** | The complete packaged Chrome Extension directory. |
| ├── [**`manifest.json`**](file:///home/levil/vs/extension/manifest.json) | Extension Manifest V3 configuration, permissions (`activeTab`, `storage`, `clipboardRead`), and host script matches (YouTube and Netflix). |
| ├── [**`config.js`**](file:///home/levil/vs/extension/config.js) | Central point of configuration for the WebSocket server URL. |
| ├── [**`content.js`**](file:///home/levil/vs/extension/content.js) | Injected script handling video elements, event hooks, RTT pings, state locks, and sync actions. |
| ├── [**`popup.html`**](file:///home/levil/vs/extension/popup.html) | Premium dark-themed, glassmorphic popup UI. |
| ├── [**`popup.js`**](file:///home/levil/vs/extension/popup.js) | Popup controller managing room lifecycle, UI state, copy/paste shortcuts, and status queries. |
| [**`server.js`**](file:///home/levil/vs/server.js) | Lightweight Node.js WebSocket signaling server. Uses environment variables (`PORT`, `HOST`) for production deployments. |
| [**`deployment_plan.md`**](file:///home/levil/vs/deployment_plan.md) | Comprehensive step-by-step production deployment documentation (SSL/TLS, WSS, Systemd services, Caddy reverse-proxy). |
| [**`task.md`**](file:///home/levil/vs/task.md) | Task list tracking development milestones and verification items. |
| [**`walkthrough.md`**](file:///home/levil/vs/walkthrough.md) | Detailed verification walkthrough with operational tests. |

---

## 🚀 Getting Started

Follow these steps to run the complete synchronization system locally on your machine.

### 1. Prerequisites

Make sure you have [Node.js](https://nodejs.org/) (v16+) installed.

### 2. Set Up & Start the Signaling Server

1. Install project dependencies:
   ```bash
   npm install
   ```
2. Start the local server:
   ```bash
   npm start
   ```
   The terminal will output:
   `WebSocket Signaling Server running on ws://127.0.0.1:8080`

### 3. Load the Extension in Google Chrome

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** using the toggle switch in the top-right corner.
3. Click the **Load unpacked** button in the top-left corner.
4. Select the `extension/` directory from this repository.
5. The extension is now successfully installed!

---

## 🎮 How to Test and Use

To verify synchronization between two remote parties (or test it locally using side-by-side tabs):

1. **Open two tabs** side-by-side and navigate to the same video on YouTube or Netflix in both.
2. **Open the extension popup in Tab 1**:
   - Click **Generate** to create a fresh Room ID.
   - Click **Copy** to save the ID to your clipboard.
   - Click **Connect & Sync**. Status changes to `Connecting...` and then `Connected (1 / 2 Peers)`.
3. **Open the extension popup in Tab 2**:
   - Click **Paste** to retrieve the Room ID from your clipboard.
   - Click **Connect & Sync**. Status changes to `Connected (2 / 2 Peers)`.
4. Play, pause, adjust playback speed, or scrub the timeline in either tab — both players will synchronize seamlessly!

---

## 🔒 Security & Safety Guidelines

- **No `innerHTML`**: Kept DOM manipulations strictly scoped to safe functions (`textContent` and `createElement`), rendering standard XSS attacks impossible.
- **Local Sandbox Bindings**: The signaling server binds exclusively to `127.0.0.1:8080` by default to prevent accidental external access during testing.
- **Secure Fallbacks**: Safe console-based fallback diagnostics alert users if background browser permission blocks clipboard operations.

---

## 🚢 Production Deployment

Before launching to external users, please review the complete [Deployment Plan](file:///home/levil/vs/deployment_plan.md).

> [!IMPORTANT]
> **HTTPS/WSS Restriction**: Chrome extensions injected into HTTPS sites (like YouTube/Netflix) will **block** insecure WebSocket (`ws://`) connections. For production, you **must** configure a TLS certificate and connect via secure WebSocket (`wss://`) using a reverse proxy (e.g., Caddy or Nginx).

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
