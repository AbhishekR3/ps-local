// Service worker: buffers each battle room's protocol frames so the panel can reconstruct
// state even when opened mid-battle, survives MV3 worker termination by persisting to
// chrome.storage.session, and toggles the panel on toolbar click.
import { api } from './lib/api.js';

console.log('[PSH bg] SW start');

const MAX_FRAMES = 2000; // per room
const MAX_ROOMS = 6;     // evict the oldest room beyond this

// storage.session persists the buffer across MV3 worker restarts. Guard against runtimes that
// don't expose it — without this, set() throws synchronously and crashes the frame handler.
const sessionStore = api.storage?.session || null;

// roomid -> array of raw frame strings. Mirrored to storage.session (debounced) so a worker
// cold-start can rehydrate instead of losing the battle (the old single in-memory buffer did).
let buffers = {};
let roomOrder = []; // insertion order, for eviction

// Frames can arrive before the async rehydrate finishes on cold start; queue until ready.
let ready = false;
const pending = [];
const readyPromise = (async () => {
	try {
		const stored = sessionStore ? await sessionStore.get('buffers') : null;
		if (stored?.buffers) {
			buffers = stored.buffers;
			roomOrder = Object.keys(buffers);
			console.log('[PSH bg] rehydrated ' + roomOrder.length + ' room(s) from session storage');
		}
	} catch (e) {
		console.warn('[PSH bg] rehydrate failed', e);
	}
	ready = true;
	for (const data of pending) handleFrame(data);
	pending.length = 0;
})();

function roomOf(frame) {
	const first = frame.split('\n', 1)[0];
	if (first.startsWith('>')) {
		const m = first.slice(1).trim().match(/^battle-[a-z0-9]+-\d+/);
		if (m) return m[0];
	}
	return null;
}

let persistTimer = null;
function schedulePersist() {
	if (!sessionStore || persistTimer) return;
	// Debounce: frames burst during a turn; persist at most ~twice a second. The worker stays
	// alive while messages flow, so the trailing write lands before the idle shutdown.
	persistTimer = setTimeout(() => {
		persistTimer = null;
		try {
			sessionStore.set({ buffers })?.catch?.((e) => console.warn('[PSH bg] persist failed', e));
		} catch (e) {
			console.warn('[PSH bg] persist threw', e);
		}
	}, 500);
}

function handleFrame(data) {
	const room = roomOf(data);
	if (!room) return;
	if (!buffers[room]) {
		buffers[room] = [];
		roomOrder.push(room);
		// Evict the oldest room(s) so a long session doesn't grow unbounded.
		while (roomOrder.length > MAX_ROOMS) delete buffers[roomOrder.shift()];
	}
	const buf = buffers[room];
	buf.push(data);
	if (buf.length > MAX_FRAMES) buf.shift();
	if (buf.length === 1 || buf.length % 25 === 0) {
		console.log('[PSH bg] frame room=' + room + ' bufferLen=' + buf.length + ' rooms=' + roomOrder.length);
	}
	schedulePersist();
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (msg.type === 'ps-frame') {
		if (!ready) pending.push(msg.data);
		else handleFrame(msg.data);
		return;
	}
	if (msg.type === 'get-buffer') {
		// Panel requests a specific room (its foreground battle). Fall back to the most-recent
		// room if none is given (e.g. an early request before the panel knows the room).
		(async () => {
			await readyPromise;
			const room = msg.room || roomOrder[roomOrder.length - 1];
			const frames = (room && buffers[room]) || [];
			console.log('[PSH bg] get-buffer room=' + room + ' → ' + frames.length + ' frames');
			// A zero-frame reply is the blank-panel smoking gun: log what rooms we DO have so we can
			// tell "no battle started yet" (empty roomOrder) from "wrong room requested" (mismatch).
			if (!frames.length) {
				console.log('[PSH bg] get-buffer EMPTY — requested=' + (msg.room || '(latest)') + ' roomOrder=[' + roomOrder.join(', ') + ']');
			}
			sendResponse({ frames, room });
		})();
		return true; // async sendResponse
	}
});

// Toolbar click: tell the content script on the active PS tab to toggle the panel.
api.action.onClicked.addListener((tab) => {
	api.tabs.sendMessage(tab.id, { type: 'toggle-panel' }).catch(() => {});
});
