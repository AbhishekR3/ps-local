// Loads the real content.js (a plain content script, not a module) inside a sandboxed mock of
// the page/extension environment and exercises the behaviors that only exist in the browser:
//  - the WebSocket-frame bridge forwards frames to the background, and
//  - an orphaned content script (extension reloaded → "Extension context invalidated") tears
//    down quietly instead of letting the synchronous throw escape on every frame.
// This is the regression guard for the integration bug seen on extension reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'extension', 'content.js'), 'utf8');

// Build a fresh sandbox + load content.js into it. Returns hooks to drive the script.
function loadContentScript({ pathname = '/battle-gen9randombattle-1' } = {}) {
	const idMap = new Map();
	const makeEl = () => {
		const el = {
			_id: '',
			style: {},
			setAttribute() {},
			addEventListener() {},
			appendChild() {},
			remove() { if (el._id) idMap.delete(el._id); },
			contentWindow: { postMessage() {} },
			get id() { return el._id; },
			set id(v) { el._id = v; if (v) idMap.set(v, el); },
		};
		return el;
	};

	const winListeners = {};
	const sandbox = {
		console: { log() {}, warn() {}, error() {} },
		setInterval: () => 1, // return a fake id; don't actually run the poll
		clearInterval() {},
		location: { pathname, hash: '' },
		document: {
			documentElement: makeEl(),
			getElementById: (id) => idMap.get(id) || null,
			createElement: () => makeEl(),
			addEventListener() {},
			removeEventListener() {},
		},
		window: {
			addEventListener(type, h) { (winListeners[type] = winListeners[type] || []).push(h); },
			removeEventListener(type, h) {
				const a = winListeners[type];
				if (a) { const i = a.indexOf(h); if (i >= 0) a.splice(i, 1); }
			},
			postMessage() {},
		},
		// Default: a healthy extension context. Tests swap sendMessage to simulate invalidation.
		chrome: {
			runtime: {
				sendMessage: () => Promise.resolve(),
				onMessage: { addListener() {} },
				getURL: (p) => 'chrome-extension://test/' + p,
			},
			storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve() } },
			tabs: { sendMessage: () => Promise.resolve() },
			action: { onClicked: { addListener() {} } },
		},
		// Stub for the auto-login config fetch in content.js; returns no credentials.
		fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
	};

	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);

	return { sandbox, idMap, winListeners, frameHandler: (winListeners.message || [])[0] };
}

const FRAME = { data: { __psHelper: true, data: '>battle-gen9randombattle-1\n|turn|1' } };

test('content script injects the panel and registers a frame listener on load', () => {
	const { idMap, frameHandler } = loadContentScript();
	assert.ok(idMap.has('__ps-helper-wrap'), 'panel wrapper injected');
	assert.equal(typeof frameHandler, 'function', 'window message (frame) listener registered');
});

test('frames are forwarded to the background while the context is healthy', () => {
	const { sandbox, frameHandler } = loadContentScript();
	const sent = [];
	sandbox.chrome.runtime.sendMessage = (msg) => { sent.push(msg); return Promise.resolve(); };

	assert.doesNotThrow(() => frameHandler(FRAME));
	assert.equal(sent.length, 1);
	assert.equal(sent[0].type, 'ps-frame');
});

test('an invalidated extension context tears down quietly instead of throwing', () => {
	const { sandbox, idMap, winListeners, frameHandler } = loadContentScript();
	// Simulate the orphaned-script state: chrome.* throws synchronously, exactly as Chrome does
	// after the extension is reloaded. The old code's .catch() could not handle a sync throw.
	let calls = 0;
	sandbox.chrome.runtime.sendMessage = () => { calls++; throw new Error('Extension context invalidated.'); };

	assert.doesNotThrow(() => frameHandler(FRAME), 'the synchronous throw must not escape the handler');

	// Teardown side effects: orphaned panel removed and the frame listener detached.
	assert.equal(idMap.has('__ps-helper-wrap'), false, 'orphaned panel element removed');
	assert.ok(!(winListeners.message || []).includes(frameHandler), 'frame listener removed');

	// Further frames are no-ops — the script stays disabled and never calls chrome.* again.
	assert.doesNotThrow(() => frameHandler(FRAME));
	assert.equal(calls, 1, 'no further background calls after teardown');
});
