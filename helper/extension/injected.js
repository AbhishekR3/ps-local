// Runs in the PAGE's JS context (world: MAIN) via manifest declaration.
// Manifest-declared content scripts bypass the page's Content Security Policy —
// Chrome injects them directly into the renderer, not via a <script> element.
// This guarantees the patch is in place before the PS bundle loads on any fresh
// page load (document_start runs before page scripts).
(function () {
	// SockJS WebSocket-transport framing: 'o' open, 'h' heartbeat, 'c[...]' close, and
	// 'a[...]' an array of JSON-encoded protocol messages. Only 'a' frames carry data;
	// each array element is one PS frame (may be multi-line, e.g. ">battle-…\n|…").
	function decodeSockJS(raw) {
		if (raw[0] !== 'a') return [];
		try {
			const arr = JSON.parse(raw.slice(1));
			return Array.isArray(arr) ? arr : [];
		} catch {
			return [];
		}
	}

	const NativeWebSocket = window.WebSocket;
	if (!NativeWebSocket || NativeWebSocket.__psHelperPatched) return;

	function PatchedWebSocket(url, protocols) {
		const ws = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
		// Only tap the simulator socket, not any other sockets the page may open.
		// Matches the public site (psim.us) AND the ps-local Electron server (localhost), so the
		// same tap powers the panel on play.pokemonshowdown.com and the Electron log writer locally.
		const isSim =
			typeof url === 'string' &&
			url.endsWith('/websocket') &&
			(url.includes('psim.us') || url.includes('localhost:8000') || url.includes('localhost:8080'));
		console.log('[PSH inject] WebSocket created:', url, '| tapped:', isSim);
		if (isSim) {
			let battleFrames = 0;
			ws.addEventListener('message', (event) => {
				if (typeof event.data !== 'string') return;
				// PS speaks SockJS over this socket, so the raw payload is SockJS-framed, not the
				// PS protocol directly. Unwrap it to the protocol messages the rest of the
				// pipeline expects (frames whose first line starts with ">battle-").
				for (const data of decodeSockJS(event.data)) {
					// Log only battle frames (first line starts with ">battle-") to cut chat/login noise.
					if (data.startsWith('>battle-')) {
						console.log('[PSH inject] battle frame #' + (++battleFrames) + ' → postMessage');
					}
					// Same-window relay to the content script — target this page's own origin, not '*'.
					window.postMessage({ __psHelper: true, data }, window.location.origin);
				}
			});
		}
		return ws;
	}

	PatchedWebSocket.prototype = NativeWebSocket.prototype;
	for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) PatchedWebSocket[k] = NativeWebSocket[k];
	PatchedWebSocket.__psHelperPatched = true;
	window.WebSocket = PatchedWebSocket;
})();
