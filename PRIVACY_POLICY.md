# Privacy Policy & Single Purpose Statement

**Last Updated:** May 26, 2026  
**Project:** Remote Video Synchronizer (RVS)  
**Repository:** [github.com/leviliangtw/rvs](https://github.com/leviliangtw/rvs)  

This document outlines the privacy practices, data handling policies, and developer compliance commitments for the **Remote Video Synchronizer (RVS)** Chrome Extension. We are fully committed to ensuring user privacy while delivering a secure, low-latency video synchronization experience.

---

## 🎯 1. Single Purpose Compliance

In strict accordance with the Chrome Web Store Program Policies, **Remote Video Synchronizer (RVS)** operates under a single, narrow, and easy-to-understand purpose:

> **"To enable real-time playback synchronization of web videos between remote users."**

Every feature implemented within this extension strictly serves this core objective. RVS does not contain any tangential functionalities, such as video downloading, media recording, ad-blocking, or web analytics tracking.

---

## 🔒 2. Permissions & Data Justification

RVS adheres to the **Principle of Least Privilege**. We only request permissions essential to function, and all data is processed securely with zero-retention.

### 📋 Clipboard Access (`clipboardRead`)
* **Purpose:** To provide a seamless user onboarding workflow. It enables the "One-Click Paste" button within the extension popup UI.
* **Data Practice:** When clicked by the user, the extension reads the clipboard text strictly to parse room tokens or invitation URLs. **This data is processed entirely locally on your device.** It is never monitored in the background, never stored, and never transmitted to any third-party or developer servers.

### 🌐 Active Tab Access (`activeTab`)
* **Purpose:** To interact with the media elements on the page the user is currently viewing.
* **Data Practice:** This permission is only triggered when the user explicitly interacts with the extension. It allows RVS to inject lightweight content scripts to bind event listeners to HTML5 `<video>` elements (capturing events such as `play`, `pause`, and `seek`).

### 📑 Tab Lifecycle Tracking (`tabs`)
* **Purpose:** To monitor tab updates and navigation lifecycles via `chrome.tabs.onUpdated`.
* **Data Practice:** This allows the background service worker to detect when a user reloads or navigates away from a synchronized video session. Upon detection, it automatically closes stale WebSocket connections and resets the toolbar icon status, optimizing user bandwidth and privacy.

---

## 📡 3. Real-Time Data & Network Security

To synchronize video playback across different peers, coordinate data must be shared in real time:

* **What is transmitted:** Only anonymous playback state coordinates, specifically: current play/pause states and numerical playback timestamps (e.g., `124.52` seconds). No personal information, browsing history, or identities are attached.
* **Transmission Protocol:** All data is encrypted and transmitted securely via **HTTPS** and **WSS (Secure WebSocket)** protocols, protected by end-to-end TLS encryption managed by our Caddy server infrastructure.
* **Data Retention:** Transmission is entirely transient and memory-based. **No data is written to databases, archived, or logged on our servers.** Once a synchronization session or room is closed, all session metadata is permanently wiped.

---

## 🛑 4. Data Sharing and Third-Party Disclosure

* **No Selling/Trading:** We do not sell, trade, or rent user data or technical metadata to any third parties.
* **No Trackers:** This extension contains no commercial analytics toolkits, user profiling scripts, or advertisement injection mechanisms.

---

## 📧 5. Contact & Support

For any inquiries regarding this Privacy Policy, compliance declarations, or technical implementations, please feel free to open an issue on our [GitHub Repository](https://github.com/leviliangtw/rvs/issues) or contact the maintainer directly.
