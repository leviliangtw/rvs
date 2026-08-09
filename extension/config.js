/**
 * @fileoverview Signaling server URL configuration. Change this before
 * packaging the extension for deployment. background.js loads this via
 * importScripts('config.js', 'tab-session.js'), and it's tab-session.js
 * that actually reads WS_SERVER_URL (hence the exported directive below).
 */
/* exported WS_SERVER_URL */
const WS_SERVER_URL = 'wss://rvs.pglnlab.com';
