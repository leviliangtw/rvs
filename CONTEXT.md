# Domain Glossary

Terms that name architectural concepts in this codebase, sharpened as they come up.

## Popup Channel

The popup's transport to the active tab's content script (`extension/popup-channel.js`). Owns `chrome.tabs.query`/`chrome.tabs.sendMessage` and the "no content script there" (`chrome.runtime.lastError`) detection, and owns the 1s `GET_STATUS` poll cadence internally via `watchStatus(callback)`. `popup.js` only ever calls `send(message, callback)` / `watchStatus(callback)` — it never touches `chrome.tabs` or `chrome.runtime.lastError` directly.

Introduced to give the popup↔content-script status exchange a single home: the transport had churned across three PRs (#33 push-based, #39 dual-transport fallback, #41 revert to polling) because "how do I talk to the content script" was repeated inline at every call site instead of living behind one interface. Deliberately polling-only — no push-mode adapter — since that's the only transport proven to work across engines (Chromium and Orion/iOS both support `chrome.tabs.sendMessage`; `chrome.tabs.connect` does not work reliably on Orion).

Scope is transport mechanics only — `content.js`'s domain logic (`applyConnect`/`applyDisconnect`-equivalent branches, the sessionStorage room-state helpers, the `GET_STATUS` response shape) stays in `content.js` and is unaffected.
