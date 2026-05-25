# Visual & System Walkthrough - Video Synchronizer Extension

This walkthrough details the successfully implemented real-time Chrome Extension Video Synchronizer (Conciliator) prototype and its signaling backend server.

---

## 🚀 How to Run the Prototype

To test this prototype locally between two tabs or windows representing two remote peers, follow these simple steps:

### Step 1: Start the Signaling Server
1. The WebSocket signaling server has been launched in the background at `ws://127.0.0.1:8080`.
2. To start it manually at any time, run:
   ```bash
   npm start
   ```
3. It will output:
   `WebSocket Signaling Server running on ws://127.0.0.1:8080`

### Step 2: Install the Chrome Extension Unpacked
1. Open Google Chrome.
2. In the URL bar, go to `chrome://extensions/`.
3. Enable **Developer mode** using the toggle switch in the top-right corner.
4. Click the **Load unpacked** button in the top-left corner.
5. In the file explorer, select the `/extension` directory in this workspace:
   `[workspace_path]/extension`
6. The extension is now loaded and active!

### Step 3: Test Real-Time Synchronization
1. Open two separate Chrome browser tabs or windows side-by-side.
2. Navigate both tabs to the same video on YouTube or Netflix (e.g. a YouTube video).
3. Click the extension icon in the toolbar on **Tab 1**:
   - Type a Room ID (e.g., `SYNC123`).
   - Click **Connect & Sync**. The status will update to `Connecting...` and then `Connected` (Peers: `1 / 2`).
4. Click the extension icon on **Tab 2**:
   - Type the *same* Room ID (`SYNC123`).
   - Click **Connect & Sync**. The status will immediately shift to `Connected` (Peers: `2 / 2`).
5. Real-time RTT latency pings will automatically kick off, measuring the network lag between the tabs and logging it to the dev tools console:
   - *Console log check:* `[Sync] Latency updated: RTT = 12ms, One-Way delay = 6ms`
6. Play, pause, seek, or change playback speed in Tab A — Tab B will instantly update with zero feedback jitter, compensating perfectly for transit latency!

---

## 🛠️ Architecture and Engineering Highlights

### 1. Minimal Signaling Server ([server.js](file:///home/levil/vc/server.js))
A highly optimized, server-side room mediator that enforces the target pairs criteria:
- Restricts each room strictly to a **maximum of 2 peers**.
- Listens locally on `127.0.0.1:8080` (preventing external exposure during test cycles).
- Automates client disconnect cleanups and notifies remaining peers in real time.

### 2. Manifest V3 Extension ([manifest.json](file:///home/levil/vc/extension/manifest.json))
Constructed fully inside the Chrome Manifest V3 specification:
- Requests permissions: `activeTab`, `storage`, and `clipboardRead` (to support seamless one-click Room ID pasting).
- Scopes injection hosts strictly to YouTube and Netflix domains.

### 3. ephemereal Popup UI ([popup.html](file:///home/levil/vc/extension/popup.html) / [popup.js](file:///home/levil/vc/extension/popup.js))
A dark-themed interface built using vanilla, responsive elements:
- Connects input actions directly to active tabs.
- Triggers background status polling to render peer state and calculated RTT values on-the-fly.
- **Helper Actions Row**: Features a **Generate** button (creates random `SYNC-XXXXXX` room IDs), a **Copy** button (transfers current ID to clipboard with fluid visual feedback), and a **Paste** button (retrieves clipboard IDs with secure console fallback warnings).

### 4. Advanced Injected Logic ([content.js](file:///home/levil/vc/extension/content.js))
The centerpiece of the application:
- **Dynamic DOM Discovery**: Constantly searches for active `<video>` tags to automatically recover from dynamic Single Page Application (SPA) DOM loads.
- **State Lock Synchronization**: Sets an `ignoreSyncEvents` lock when executing programmatic actions (`video.play()`, `video.currentTime = X`), preventing endless message loops.
- **Latency-Compensated Seeks**: Automatically shifts seeks and play triggers forward by `one_way_latency` seconds (`targetTime = time + (oneWayLatency / 1000)`), aligning frames perfectly regardless of transport delays.
- **RTT Pings**: Every 5 seconds, issues in-band peer-to-peer pings to log and monitor latency updates.

---

## 🔒 Security & Guidelines Audit

- [x] **No `innerHTML` Usage**: Kept all DOM manipulations strict to `textContent` and basic browser element interactions, ensuring 0% XSS injection vulnerabilities.
- [x] **Local Port Binding**: Bound the WebSocket server strictly to `127.0.0.1` and port `8080` to keep the testing sandbox safe.
- [x] **No Speculative Abstractions**: Written directly to target video events without arbitrary abstraction layers, keeping the prototype lightweight.
- [x] **Secure Alerts**: Native dialogue notifications (`alert`, `confirm`) are explicitly documented with standard `TODO(security)` flags to facilitate future migration to styled custom templates.
