// Ambient globals for the extension scripts.
//
// WS_SERVER_URL is defined in config.js and injected into the service-worker
// global scope at runtime via importScripts('config.js'). TypeScript does not
// model importScripts, so under node16 module resolution it can't see the
// cross-file global — declare it here so background.js type-checks.
declare const WS_SERVER_URL: string;
