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

// popup-channel.js populates window.RVS in the popup realm; players.js and
// connection-state.js both populate it in the content-script realm (loaded
// in that order, each merging into window.RVS rather than overwriting it —
// see connection-state.js). The popup realm never coexists with the
// content-script realm, but players.js and connection-state.js do, hence
// every member here being optional rather than assuming exactly one factory
// is ever present.
interface RvsPopupChannel {
  send(msg: object, callback: (response: any) => void): void;
  watchStatus(callback: (response: any) => void): () => void;
}

interface RvsConnectionSnapshot {
  status: string;
  peersCount: number;
  latency: number | null;
  peerMediaInfo: { title: string; url: string } | null;
}

interface RvsConnectionState {
  connect(): void;
  disconnect(): void;
  handleState(update: {
    status: string;
    peersCount: number;
    roomId?: string;
  }): { confirmedRoomId: string | null; isJustPaired: boolean };
  handleLatencyUpdate(latency: number): void;
  handleMediaInfo(update: { title?: string; url?: string }): void;
  handleError(): void;
  getSnapshot(): RvsConnectionSnapshot;
}

interface RvsNamespace {
  createDirectPlayer?(deps: { getVideo: () => HTMLVideoElement | null }): RvsPlayer;
  createBridgePlayer?(): RvsPlayer;
  createPopupChannel?(): RvsPopupChannel;
  createConnectionState?(): RvsConnectionState;
}

interface Window {
  RVS: RvsNamespace;
}
