/// <reference types="chrome" />
//
// Ambient globals for the extension scripts.
//
// WS_SERVER_URL is defined in config.js and injected into the service-worker
// global scope at runtime via importScripts('config.js'). TypeScript does not
// model importScripts, so under node16 module resolution it can't see the
// cross-file global — declare it here so background.js type-checks.
declare const WS_SERVER_URL: string;

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

interface RvsNamespace {
  createDirectPlayer(deps: { getVideo: () => HTMLVideoElement | null }): RvsPlayer;
  createBridgePlayer(): RvsPlayer;
}

interface Window {
  RVS: RvsNamespace;
}
