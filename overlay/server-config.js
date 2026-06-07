'use strict';
// ps-local overlay — DO NOT EDIT this copy in vendor/. Edit overlay/server-config.js and run
// `npm run apply-overlay`. apply-overlay copies this onto the gitignored
// vendor/pokemon-showdown/config/config.js. The server merges it OVER config-example.js defaults
// (server/config-loader.ts: `{ ...defaults, ...require(config.js) }`), so only keys that differ
// from upstream need to be set here.

// Local server port — matches the client's ?~~localhost:8000 target.
exports.port = 8000;

// Bind to all interfaces for local dev.
exports.bindaddress = '0.0.0.0';

// Local play: let users pick any name via /trn without a login-server token.
exports.noguestsecurity = true;

// No REPL — avoids creating unix sockets under logs/repl/ for a local app.
exports.repl = false;
