// Runs in the ISOLATED content-script world.
// Bridges the page-context WebSocket tap (injected.js, world: MAIN) to the background
// buffer and directly to the panel iframe, and manages the panel overlay.
//
// The tap lives in injected.js, declared as world: MAIN in the manifest. Manifest-declared
// content scripts bypass the page's CSP; a <script> element injected from here would not.
//
// Content scripts in MV3 run as regular scripts (not ES modules), so the api shim is
// inlined here rather than imported.
const api = globalThis.browser ?? globalThis.chrome;

// Origin of the panel iframe (chrome-extension://… / moz-extension://…). Used as the explicit
// targetOrigin when posting to the panel, and to validate messages coming back from it. Derived by
// string-slicing the extension URL (scheme://host) so it needs no URL global.
const PANEL_ORIGIN = api.runtime.getURL('panel.html').split('/').slice(0, 3).join('/');

const DEFAULT_WIDTH = 340;
const MIN_WIDTH = 260;
const MAX_WIDTH = 680;

// --- panel iframe injection ---------------------------------------------------
let panelFrame = null;
let panelVisible = false;
// Last tap-health signal injected.js posted (no battle frames are flowing). Cached so a panel
// opened after the one-shot 15s/framing warning still learns the tap is dead.
let lastTapStatus = null;

// The battle the user is currently viewing. The PS client routes rooms via the URL — the
// modern client uses the pathname (e.g. "/battle-gen9randombattle-123"), older builds use the
// hash ("#battle-..."). Check both so detection works regardless of client version. We scope
// the live panel feed to this room so frames from other open battles don't thrash the tracker.
function foregroundRoom() {
	for (const s of [location.pathname, location.hash]) {
		const m = (s || '').match(/battle-[a-z0-9]+-\d+/);
		if (m) return m[0];
	}
	return null;
}

function roomOf(frame) {
	const first = frame.split('\n', 1)[0];
	if (first.startsWith('>')) {
		const m = first.slice(1).trim().match(/^battle-[a-z0-9]+-\d+/);
		if (m) return m[0];
	}
	return null;
}

function injectPanel() {
	const wrap = document.createElement('div');
	wrap.id = '__ps-helper-wrap';
	// Fixed right-side overlay; translateX hides it off-screen when closed.
	wrap.style.cssText = [
		'position:fixed', 'top:0', 'right:0', `width:${DEFAULT_WIDTH}px`, 'height:100dvh',
		'z-index:2147483647', 'box-shadow:-3px 0 12px rgba(0,0,0,.5)',
		'transform:translateX(100%)', 'transition:transform .2s ease',
		'border:none', 'padding:0', 'margin:0',
	].join(';');

	const iframe = document.createElement('iframe');
	// Pass the page origin so the panel can validate inbound messages and target us back precisely.
	iframe.src = api.runtime.getURL('panel.html') + '?pageOrigin=' + encodeURIComponent(location.origin);
	iframe.style.cssText = 'width:100%;height:100%;border:none;display:block;';
	iframe.setAttribute('allowtransparency', 'false');
	iframe.addEventListener('load', () => console.log('[PSH content] panel iframe loaded'));

	wrap.appendChild(iframe);
	wrap.appendChild(makeResizeGrip(wrap, iframe));
	document.documentElement.appendChild(wrap);
	panelFrame = iframe;

	// Restore the user's saved width (persisted on drag-end).
	api.storage.local.get('panelWidth').then(({ panelWidth }) => {
		if (panelWidth) wrap.style.width = clampWidth(panelWidth) + 'px';
	}).catch(() => {});

	console.log('[PSH content] injectPanel: iframe created, src=' + iframe.src);
}

const clampWidth = (w) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(w)));

// Left-edge drag handle. The panel is right-anchored, so dragging left widens it.
function makeResizeGrip(wrap, iframe) {
	const grip = document.createElement('div');
	grip.style.cssText = [
		'position:absolute', 'top:0', 'left:0', 'width:7px', 'height:100%',
		'cursor:ew-resize', 'z-index:1', 'background:transparent',
	].join(';');

	grip.addEventListener('mousedown', (e) => {
		e.preventDefault();
		const startX = e.clientX;
		const startW = wrap.getBoundingClientRect().width;
		// While dragging, let the page (not the iframe) receive mousemove events.
		iframe.style.pointerEvents = 'none';
		wrap.style.transition = 'none';

		const onMove = (ev) => {
			wrap.style.width = clampWidth(startW + (startX - ev.clientX)) + 'px';
		};
		const onUp = () => {
			document.removeEventListener('mousemove', onMove);
			document.removeEventListener('mouseup', onUp);
			iframe.style.pointerEvents = '';
			wrap.style.transition = 'transform .2s ease';
			const width = clampWidth(wrap.getBoundingClientRect().width);
			api.storage.local.set({ panelWidth: width }).catch(() => {});
			console.log('[PSH content] panel width saved: ' + width);
		};
		document.addEventListener('mousemove', onMove);
		document.addEventListener('mouseup', onUp);
	});
	return grip;
}

function setVisible(v) {
	panelVisible = v;
	const wrap = document.getElementById('__ps-helper-wrap');
	if (wrap) wrap.style.transform = v ? 'translateX(0)' : 'translateX(100%)';
	// Notify the panel when it becomes visible so it can re-seed from the buffer for the
	// room currently being viewed. init() in panel.js runs at page load (before any battle),
	// so this re-sync catches a battle that started after the page loaded.
	if (v) {
		console.log('[PSH content] setVisible true, posting panel-shown room=' + foregroundRoom());
		panelFrame?.contentWindow?.postMessage({ type: 'panel-shown', room: foregroundRoom() }, PANEL_ORIGIN);
		// Replay a cached dead-tap signal: the one-shot warning may have fired before the panel opened.
		if (lastTapStatus) panelFrame?.contentWindow?.postMessage({ type: 'tap-status', ...lastTapStatus }, PANEL_ORIGIN);
	}
}

// When the extension is reloaded/updated, content scripts already running in open tabs become
// orphaned: any chrome.* call throws "Extension context invalidated" (synchronously, so a
// .catch() doesn't help). Detect that and tear down quietly — the page must be reloaded to get
// a fresh content script anyway.
let dead = false;
let pollId = null;

function teardown() {
	if (dead) return;
	dead = true;
	console.warn('[PSH content] extension context invalidated — disabling orphaned script. Reload the PS tab (Cmd-Shift-R).');
	window.removeEventListener('message', frameHandler);
	if (pollId) clearInterval(pollId);
	document.getElementById('__ps-helper-wrap')?.remove();
}

// Send to the background, surviving both async rejection and the synchronous throw that an
// invalidated context raises.
function safeSend(message) {
	if (dead) return;
	try {
		api.runtime.sendMessage(message)?.catch?.(() => {});
	} catch {
		teardown();
	}
}

// Detect battle switches by watching the URL. The PS client navigates via the History API
// (pushState), which fires neither `hashchange` nor `popstate` on tab clicks, so we poll.
let lastForeground = foregroundRoom();
pollId = setInterval(() => {
	const room = foregroundRoom();
	if (room !== lastForeground) {
		lastForeground = room;
		console.log('[PSH content] foreground room → ' + room);
		panelFrame?.contentWindow?.postMessage({ type: 'room-changed', room }, PANEL_ORIGIN);
	}
}, 700);

// --- Auto-hide the PS lobby rooms/news sidebar --------------------------------
// The sidebar has a "▶ Hide" button that appears after the PS app builds its DOM.
// We observe the DOM and click it once on the lobby (not inside a battle room).
function autoHideRooms() {
	if (foregroundRoom()) return; // skip when already viewing a battle

	function tryHide() {
		const el = document.querySelector('button[name="closerooms"], .closebutton')
			|| Array.from(document.querySelectorAll('button, a'))
				.find(e => e.textContent.trim() === 'Hide');
		if (el) { el.click(); return true; }
		return false;
	}

	if (!tryHide()) {
		const obs = new MutationObserver(() => { if (tryHide()) obs.disconnect(); });
		obs.observe(document.documentElement, { childList: true, subtree: true });
		setTimeout(() => obs.disconnect(), 10000);
	}
}

// --- Auto-login using credentials from data/config.json ----------------------
// PS login is a two-step UI flow: click the "Choose name" button → fill username
// → submit → fill password → submit. We skip if already logged in.
function autoLogin(username, password) {
	let step = 'trigger'; // 'trigger' | 'username' | 'password' | 'done'

	function fillAndSubmit(input) {
		input.focus();
		// Dispatch a native input event so PS's React/framework picks up the value change.
		// eslint-disable-next-line no-unsanitized/method -- false positive; getOwnPropertyDescriptor is not an XSS sink
		const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
		if (nativeInputSetter) nativeInputSetter.call(input, step === 'username' ? username : password);
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new Event('change', { bubbles: true }));
		const form = input.closest('form');
		if (form) {
			form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		} else {
			// Fallback: find the nearest submit button or press Enter.
			const btn = input.parentElement?.querySelector('button[type="submit"], button:not([type="button"])')
				|| document.querySelector('.popup button[type="submit"], .popup button:not([type="button"])');
			if (btn) btn.click();
			else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		}
	}

	function tryStep() {
		if (step === 'trigger') {
			// Skip if already logged in — PS shows the username in a button/link when logged in.
			const loginBtn = document.querySelector('button[name="login"], .login-button')
				|| Array.from(document.querySelectorAll('button, a'))
					.find(e => e.textContent.trim() === 'Choose name' || e.textContent.trim() === 'Log in');
			if (!loginBtn) return false; // not rendered yet
			loginBtn.click();
			step = 'username';
			return true;
		}
		if (step === 'username') {
			const input = document.querySelector('input[name="username"]');
			if (!input) return false;
			fillAndSubmit(input);
			step = 'password';
			return true;
		}
		if (step === 'password') {
			const input = document.querySelector('input[name="password"]');
			if (!input) return false;
			fillAndSubmit(input);
			step = 'done';
			obs.disconnect();
			return true;
		}
		return false;
	}

	const obs = new MutationObserver(tryStep);
	obs.observe(document.documentElement, { childList: true, subtree: true });
	tryStep(); // attempt immediately in case DOM is already ready
	setTimeout(() => obs.disconnect(), 15000); // give up after 15 s
}

// Load credentials and kick off auto-login.
fetch(api.runtime.getURL('data/config.json'))
	.then(r => r.json())
	.then(cfg => { if (cfg.username && cfg.password) autoLogin(cfg.username, cfg.password); })
	.catch(() => {}); // missing config.json is fine — just don't auto-login

// Inject as soon as the document element exists (run_at: document_start).
// Guard against double-injection if the script somehow runs twice.
if (!document.getElementById('__ps-helper-wrap')) {
	if (document.documentElement) {
		injectPanel();
		setVisible(true);
		autoHideRooms();
	} else {
		new MutationObserver((_, obs) => {
			if (document.documentElement) { obs.disconnect(); injectPanel(); setVisible(true); autoHideRooms(); }
		}).observe(document, { childList: true });
	}
}

// --- WebSocket bridge ---------------------------------------------------------
// The most recent battle roomid seen on the wire. The PS client sometimes routes a battle
// without changing location.pathname/hash in the form foregroundRoom() matches (client-version
// quirks, tab focus without nav). When URL detection misses, this wire-derived roomid is the
// implicit foreground so the panel still gets fed and never sits blank mid-battle.
let lastWireRoom = null;

function frameHandler(event) {
	if (dead) return;
	if (event.origin !== location.origin) return; // only the page's own MAIN-world tap posts here
	// Do NOT check event.source === window here. In Chrome, MAIN-world → ISOLATED-world
	// postMessage delivers a different window proxy as event.source, so that check always
	// fails and silently drops every frame from injected.js. The __psHelper flag below
	// is sufficient to identify messages that came from our script.
	const msg = event.data;
	if (!msg || msg.__psHelper !== true) return;

	// Tap-health signal from injected.js (carries `tap`, no `data`). The tap is alive but sees no
	// battle frames — forward to the panel for its "battle data unavailable" banner and cache it.
	if (typeof msg.tap === 'string') {
		lastTapStatus = { tap: msg.tap, reason: msg.reason };
		panelFrame?.contentWindow?.postMessage({ type: 'tap-status', tap: msg.tap, reason: msg.reason }, PANEL_ORIGIN);
		return;
	}

	if (typeof msg.data !== 'string') return;

	const room = roomOf(msg.data);

	// Buffer EVERY room in the background (survives panel open/close and SW restart).
	safeSend({ type: 'ps-frame', data: msg.data });

	// First frame of a battle room we haven't told the panel about yet → kick a resync for it,
	// regardless of whether the URL has updated. This is what makes "open the panel before the
	// game starts" populate the moment the game's first frame hits the tap, instead of waiting
	// on the 700ms URL poller (which never fires if the client routes without a URL change).
	if (room && room !== lastWireRoom) {
		lastWireRoom = room;
		if (room !== lastForeground) {
			lastForeground = room;
			console.log('[PSH content] first wire frame for ' + room + ' → room-changed (url fg=' + foregroundRoom() + ')');
			panelFrame?.contentWindow?.postMessage({ type: 'room-changed', room }, PANEL_ORIGIN);
		}
	}

	// Forward live for the room the user is currently viewing, so a second open battle can't
	// interleave frames into the panel and corrupt its state. When the URL gives us a foreground
	// room, scope to it; when it doesn't (unknown client routing), fall back to the room last seen
	// on the wire so a single active battle still feeds the panel instead of going blind.
	const fg = foregroundRoom() || lastWireRoom;
	const forwarded = !!room && (room === fg || !fg);
	if (forwarded) {
		panelFrame?.contentWindow?.postMessage({ type: 'ps-frame', data: msg.data }, PANEL_ORIGIN);
	} else if (room) {
		// Sampled: log only when we DROP a battle frame (the interesting/diagnostic case).
		console.log('[PSH content] dropped frame room=' + room + ' fg=' + fg);
	}
}
window.addEventListener('message', frameHandler);

// --- handle messages from the background and from the panel itself ------------
api.runtime.onMessage.addListener((msg) => {
	if (msg?.type === 'toggle-panel') {
		console.log('[PSH content] toggle-panel');
		setVisible(!panelVisible);
	}
});

// The panel's close button posts a message to its parent (this content script).
window.addEventListener('message', (event) => {
	if (event.origin === PANEL_ORIGIN && event.source === panelFrame?.contentWindow && event.data?.type === 'close-panel') {
		setVisible(false);
	}
});

// Electron menu / keyboard shortcut: main process fires executeJavaScript which posts this.
window.addEventListener('message', (event) => {
	if (event.data?.type === 'ps-toggle-panel') setVisible(!panelVisible);
});
