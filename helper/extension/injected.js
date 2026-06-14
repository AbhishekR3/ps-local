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

	// Diagnostics: turn the two silent failure modes (no sim socket ever opens; the socket speaks an
	// unexpected framing) into a visible warning, so a blank panel has a discoverable cause.
	let simSocketSeen = false;
	let framingWarned = false;
	const KNOWN_SOCKJS_PREFIXES = new Set(['o', 'h', 'a', 'c']); // open / heartbeat / array / close
	setTimeout(() => {
		if (!simSocketSeen) {
			console.warn('[PSH inject] no simulator WebSocket observed ~15s after load — the tap saw no ' +
				'/websocket connection to psim.us/localhost. If PS changed its socket URL, the panel will stay blank.');
			// Surface the dead tap to the panel (no `data` field → frame relays ignore it; only the
			// tap-status consumers in content.js act on it). Same target as battle frames: the page origin.
			window.postMessage({ __psHelper: true, tap: 'inactive', reason: 'no-socket' }, window.location.origin);
		}
	}, 15000);

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
			simSocketSeen = true;
			let battleFrames = 0;
			ws.addEventListener('message', (event) => {
				if (typeof event.data !== 'string') return;
				// Unexpected leading byte = the SockJS framing this tap assumes ('a[...]' data frames)
				// has changed; decodeSockJS would silently yield nothing. Warn once so it's diagnosable.
				if (event.data.length && !KNOWN_SOCKJS_PREFIXES.has(event.data[0]) && !framingWarned) {
					framingWarned = true;
					console.warn('[PSH inject] unexpected SockJS frame prefix ' + JSON.stringify(event.data[0]) +
						' — the framing the tap decodes may have changed; battle frames could be dropped.');
					// The socket is alive but its framing changed → decodeSockJS yields nothing. Tell the panel
					// so it shows a "battle data unavailable" banner instead of an endless blank "waiting" state.
					window.postMessage({ __psHelper: true, tap: 'inactive', reason: 'framing' }, window.location.origin);
				}
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
