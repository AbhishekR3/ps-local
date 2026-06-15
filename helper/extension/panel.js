import { BattleTracker } from './lib/parser.js';
import { resolveSetsKey } from './lib/lookup.js';
import { loadCore, loadSets, loadItems, loadAbilities, loadTera, loadStats, loadMovesFreq } from './lib/data.js';
import { renderBattle } from './lib/render.js';
import { api } from './lib/api.js';

// Proves the iframe actually loaded and ran panel.js (hypothesis H1).
console.log('[PSH panel] loaded');

const tracker = new BattleTracker();
let core = null;          // {pokedex, moves, abilitiesDesc}
let currentSets = null;      // sets object for the current format
let currentItems = null;     // predicted-item table for the current format (may be null)
let currentAbilities = null; // predicted-ability table for the current format (may be null)
let currentTeras = null;     // tera-type frequency table for the current format (may be null)
let currentStats = null;     // pre-nature stat min/max table for the current format (may be null)
let currentMovesFreq = null; // move-frequency table for the current format (may be null)
let currentSetsKey = null;
let renderQueued = false;
// Set by a tap-status message from content.js when the WebSocket tap sees no battle frames (dead
// socket / changed framing). Drives the "battle data unavailable" banner; cleared once frames arrive.
let tapWarning = null;

const $format = document.getElementById('format');
const $content = document.getElementById('content');

// The parent (content script) passes its page origin via the iframe URL so we can validate inbound
// messages and target replies precisely. When running inside the extension the param is always present;
// the '*' fallback is only for genuine standalone dev loads (chrome-extension://…/panel.html opened
// directly). Refuse the wildcard inside the extension — accepting any origin there would let any framing
// page post frames in.
const PAGE_ORIGIN = (() => {
	const param = new URLSearchParams(location.search).get('pageOrigin');
	if (param) return param;
	if (api?.runtime?.id) {
		console.warn('[PSH panel] no pageOrigin param under extension runtime — refusing the "*" wildcard');
		return null; // matches no event.origin, so inbound messages are ignored until reloaded with the param
	}
	return '*';
})();

document.getElementById('close-btn').addEventListener('click', () => {
	window.parent.postMessage({ type: 'close-panel' }, PAGE_ORIGIN || '*');
});

async function ensureSets() {
	const key = resolveSetsKey(tracker.state.formatId);
	if (key !== currentSetsKey) {
		currentSetsKey = key;
		[currentSets, currentItems, currentAbilities, currentTeras, currentStats, currentMovesFreq] = await Promise.all([
			loadSets(key), loadItems(key), loadAbilities(key), loadTera(key), loadStats(key), loadMovesFreq(key),
		]);
	}
}

// Coalesce bursts of frames into one render per animation frame.
function scheduleRender() {
	if (renderQueued) return;
	renderQueued = true;
	requestAnimationFrame(() => {
		renderQueued = false;
		void ensureSets().then(render).catch((e) => console.warn('[PSH panel] render failed', e));
	});
}

function render() {
	const s = tracker.state;
	console.log('[PSH panel] render formatId=' + s.formatId + ' tier=' + s.tier + ' core=' + !!core);
	const fmt = { sets: currentSets, items: currentItems, abilities: currentAbilities, teras: currentTeras, movesFreq: currentMovesFreq, stats: currentStats };
	const { format, html } = renderBattle(s, core, fmt, { tapWarning });
	$format.textContent = format;
	$content.innerHTML = html; // eslint-disable-line no-unsanitized/property -- html from our own renderBattle(), never user input
}

// --- wire up data flow --------------------------------------------------------

// Live frames come via postMessage from the parent content script.
// (Using postMessage instead of runtime.onMessage because this panel is loaded
// inside an iframe embedded in the PS page — postMessage is reliable in all browsers
// for this cross-context setup.)
window.addEventListener('message', (event) => {
	if (PAGE_ORIGIN !== '*' && event.origin !== PAGE_ORIGIN) return; // only our parent page posts here
	if (event.data?.type === 'tap-status') {
		// Tap is alive-but-blind (dead socket / changed framing). Show a banner instead of a blank wait.
		tapWarning = event.data.tap === 'inactive' ? (event.data.reason || 'inactive') : null;
		scheduleRender();
		return;
	}
	if (event.data?.type === 'ps-frame') {
		const isBattle = typeof event.data.data === 'string' && event.data.data.startsWith('>battle-');
		// A frame arrived → the tap works after all; clear any stale dead-tap banner.
		if (isBattle) tapWarning = null;
		// Capture the tracker's current roomid before feed() so a mismatch (incoming frame for a
		// different room than the tracker is on) is visible — that's the signature of feed()'s
		// auto-reset kicking in for a fresh battle vs. an in-progress one.
		const prevRoom = tracker.state.roomid;
		const incomingRoom = isBattle ? (event.data.data.split('\n', 1)[0].slice(1).trim().match(/^battle-[a-z0-9]+-\d+/)?.[0] || null) : null;
		tracker.feed(event.data.data);
		const s = tracker.state;
		if (isBattle) {
			console.log('[PSH panel] ps-frame recv (battle) trackerRoom=' + prevRoom + '→' + s.roomid +
				' incoming=' + incomingRoom + ' formatId=' + s.formatId +
				' tier=' + s.tier + ' mySide=' + s.mySide + ' activeCount=' + Object.keys(s.active).length);
		}
		scheduleRender();
	}
	// content.js fires panel-shown (on open) and room-changed (on battle switch), each with
	// the foreground room id. Reset and re-seed from THAT room's buffer so we never show a
	// stale battle and always rebuild fully when reopened mid-game.
	if (event.data?.type === 'panel-shown' || event.data?.type === 'room-changed') {
		console.log('[PSH panel] ' + event.data.type + ' → resync room=' + event.data.room);
		resync(event.data.room);
	}
});

async function resync(room) {
	tracker.reset();
	// Pass the foreground room when known; when null (couldn't detect routing) the background
	// falls back to the most-recent buffered room, so the panel never goes blank mid-battle.
	// A finished/left battle ends with |deinit in its buffer, which render() shows as "waiting".
	const resp = await api.runtime.sendMessage({ type: 'get-buffer', room: room || undefined }).catch(() => null);
	console.log('[PSH panel] resync room=' + (room || '(latest)') + ': buffer frames = ' + (resp?.frames?.length ?? '(null)'));
	if (resp?.frames?.length) for (const f of resp.frames) tracker.feed(f);
	console.log('[PSH panel] resync: after feed formatId=' + tracker.state.formatId + ' tier=' + tracker.state.tier);
	await ensureSets();
	render();
}

async function init() {
	try {
		core = await loadCore();
		console.log('[PSH panel] init: core loaded');
	} catch (e) {
		console.warn('[PSH panel] init: loadCore error', e);
	}
	// Live frames (foreground-scoped by content.js) build state from here on; panel-shown
	// resyncs from the buffer when the user opens the panel. Just render the waiting state now.
	scheduleRender();
}

init();
