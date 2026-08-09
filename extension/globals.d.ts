/// <reference types="chrome" />
//
// Ambient globals for the extension scripts.
//
// WS_SERVER_URL is defined in config.js and injected into the service
// worker's global scope via importScripts('config.js'). TypeScript can't
// model importScripts, so declare it here for background.js to type-check.
declare const WS_SERVER_URL: string;

// tab-session.js loads into the same service-worker scope the same way
// (importScripts('tab-session.js')); declare createTabSession here since
// TypeScript can't see the cross-file global. updateIcon is an explicit
// dependency background.js passes in, not a bare global, so it needs no
// declaration here.
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

// players.js builds the write-path player adapters and exposes them on
// window.RVS for content.js to reach across content scripts. TypeScript
// doesn't model that cross-file global, so declare it.
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

// The command envelope players.js's bridge player posts via
// window.postMessage and netflix-bridge.js (MAIN-world) receives.
// `action`/`time`/`rate` match RvsSyncCommand; __rvs/id are the
// postMessage envelope on top. Unlike other interfaces here, this isn't
// shared via window.RVS (the two realms don't share one) — it's a
// compile-time contract both sides agree on independently.
interface RvsBridgeCommand {
  __rvs: 'cmd';
  id: number;
  action: 'play' | 'pause' | 'seek' | 'rate';
  time?: number;
  rate?: number;
}

// Multiple files populate window.RVS in each realm (popup: popup-channel.js
// + shared-utils.js; content script: players.js, shared-utils.js,
// connection-state.js, background-port.js), each merging in
// (`window.RVS = { ...window.RVS, x }`) rather than overwriting, so none
// depend on load order. shared-utils.js loads into both realms but each
// gets its own window.RVS, so this shares source, not runtime state —
// hence every member below being optional, not assuming one factory only.
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

interface RvsBackgroundPort {
  send(msg: object): void;
}

// video-integration.js's deep module: the YouTube/Netflix-only half of
// content.js's job (the <video> element, write-path player, "Now
// Watching" broadcaster) behind one seam. Only constructed when
// isSyncSupported (ADR-0001); content.js holds exactly this interface.
interface RvsVideoIntegration {
  apply(msg: RvsSyncCommand): void;
  shareMediaInfo(force: boolean): void;
  forgetSharedMedia(): void;
}

interface RvsNamespace {
  createDirectPlayer?(deps: { getVideo: () => HTMLVideoElement | null }): RvsPlayer;
  createBridgePlayer?(): RvsPlayer;
  createPopupChannel?(): RvsPopupChannel;
  createConnectionState?(): RvsConnectionState;
  generateRoomId?(): string;
  createBackgroundPort?(deps: {
    onMessage: (msg: any) => void;
    onConnect: (send: (msg: object) => void) => void;
  }): RvsBackgroundPort;
  createVideoIntegration?(deps: {
    isNetflix: boolean;
    getSnapshot: () => RvsConnectionSnapshot;
    send: (msg: object) => void;
    isDifferentVideoFromPeer: () => boolean;
  }): RvsVideoIntegration;
  isHost?(hostname: string, domain: string): boolean;
}

interface Window {
  RVS: RvsNamespace;
}
