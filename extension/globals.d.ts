/// <reference types="chrome" />
//
// Ambient globals for the extension scripts.
//
// WS_SERVER_URL is defined in config.js and injected into the service-worker
// global scope at runtime via importScripts('config.js'). TypeScript does not
// model importScripts, so under node16 module resolution it can't see the
// cross-file global — declare it here so background.js type-checks.
declare const WS_SERVER_URL: string;

// tab-session.js is loaded into the same service-worker scope the same way
// (importScripts('tab-session.js')); background.js calls createTabSession —
// declare it here since TypeScript can't see the cross-file global.
// updateIcon is passed in by background.js as an explicit dependency (not a
// bare global tab-session.js reaches for), so it doesn't need declaring here.
interface TabSession {
  rebind(port: chrome.runtime.Port): void;
  disconnect(deadPort: chrome.runtime.Port, lastErrorMessage: string | undefined): boolean;
  handlePortMessage(msg: any): void;
  getStatus(): string;
}
declare function createTabSession(
  tabId: number,
  deps: { updateIcon: (tabId: number, status: string) => void }
): TabSession;

// players.js builds the write-path player adapters and exposes them on window.RVS
// so content.js can reach them across content scripts without relying on shared
// lexical scope. TypeScript doesn't model that cross-file global, so declare it.
interface RvsSyncCommand {
  action: 'play' | 'pause' | 'seek' | 'rate';
  time?: number;
  rate?: number;
}

interface RvsPlayer {
  apply(msg: RvsSyncCommand): void;
  isApplying(): boolean;
  onVideoReady(): void;
}

// popup-channel.js (popup realm) and players.js (content-script realm) each
// populate window.RVS with only their own factory — the two never coexist in
// the same JS realm, so every member here is optional.
interface RvsPopupChannel {
  send(message: object, callback: (response: any) => void): void;
  watchStatus(callback: (response: any) => void): () => void;
}

interface RvsNamespace {
  createDirectPlayer?(deps: { getVideo: () => HTMLVideoElement | null }): RvsPlayer;
  createBridgePlayer?(): RvsPlayer;
  createPopupChannel?(): RvsPopupChannel;
}

interface Window {
  RVS: RvsNamespace;
}
