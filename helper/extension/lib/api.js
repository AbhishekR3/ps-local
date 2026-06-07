// Cross-browser extension API shim.
// Firefox/Safari use `browser` (Promises); Chrome uses `chrome` (callbacks, but also
// supports `browser` via a shim on Chrome 120+). Always prefer `browser` when present.
export const api = globalThis.browser ?? globalThis.chrome;
