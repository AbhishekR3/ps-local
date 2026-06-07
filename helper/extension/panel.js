import { BattleTracker } from './lib/parser.js';
import { resolveSetsKey, getBreakdown } from './lib/lookup.js';
import { loadCore, loadSets, loadItems, loadAbilities, loadTera, loadStats, loadMovesFreq } from './lib/data.js';
import { api } from './lib/api.js';
import { generateBattleLog } from './lib/exporter.js';

// Proves the iframe actually loaded and ran panel.js (hypothesis H1).
console.log('[PSH panel] loaded');

const tracker = new BattleTracker();
let core = null;          // {pokedex, moves}
let currentSets = null;      // sets object for the current format
let currentItems = null;     // predicted-item table for the current format (may be null)
let currentAbilities = null; // predicted-ability table for the current format (may be null)
let currentTeras = null;     // tera-type frequency table for the current format (may be null)
let currentStats = null;     // pre-nature stat min/max table for the current format (may be null)
let currentMovesFreq = null; // move-frequency table for the current format (may be null)
let currentSetsKey = null;
let renderQueued = false;
const downloadedRooms = new Set(); // roomids already auto-downloaded this panel session

const $format = document.getElementById('format');
const $content = document.getElementById('content');

document.getElementById('close-btn').addEventListener('click', () => {
	window.parent.postMessage({ type: 'close-panel' }, '*');
});

async function triggerDownload(state) {
	const resp = await api.runtime.sendMessage({ type: 'get-buffer', room: state.roomid || undefined }).catch(() => null);
	const frames = resp?.frames || [];
	const text = generateBattleLog(state, frames, core?.moves || {});
	const blob = new Blob([text], { type: 'text/plain' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	const mySide = state.mySide || 'p1';
	const oppSide = mySide === 'p1' ? 'p2' : 'p1';
	const oppName = (state.players[oppSide]?.name || 'opp').replace(/[^a-z0-9]/gi, '');
	const result = !state.ended ? 'INPROGRESS'
		: state.winner && state.winner === state.players[mySide]?.name ? 'WIN'
		: state.winner ? 'LOSS' : 'TIE';
	a.download = `${state.roomid || 'battle'}_${result}_vs_${oppName}.txt`;
	a.click();
	URL.revokeObjectURL(url);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
	{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function opponentSide() {
	const me = tracker.state.mySide;
	if (me) return me === 'p1' ? 'p2' : 'p1';
	return 'p2'; // sensible default before the first |request| arrives
}

// Coalesce bursts of frames into one render per animation frame.
function scheduleRender() {
	if (renderQueued) return;
	renderQueued = true;
	requestAnimationFrame(async () => {
		console.log('[PSH panel] rAF fired');
		renderQueued = false;
		await ensureSets();
		render();
	});
}

async function ensureSets() {
	const key = resolveSetsKey(tracker.state.formatId);
	if (key !== currentSetsKey) {
		currentSetsKey = key;
		[currentSets, currentItems, currentAbilities, currentTeras, currentStats, currentMovesFreq] = await Promise.all([
			loadSets(key), loadItems(key), loadAbilities(key), loadTera(key), loadStats(key), loadMovesFreq(key),
		]);
	}
}

// Compute actual in-battle stats assuming standard random-battle spreads: 31 IVs, 84 EVs.
// Returns {val, lo, hi} where val is neutral, lo is -nature, hi is +nature (HP has no nature).
function calcStatRange(base, level, isHP = false) {
	const ev21 = 21; // floor(84 / 4)
	const inner = Math.floor((2 * base + 31 + ev21) * level / 100);
	const val = isHP ? inner + level + 10 : inner + 5;
	if (isHP) return { val, lo: val, hi: val };
	return { val, lo: Math.floor(val * 0.9), hi: Math.floor(val * 1.1) };
}

// Like calcStatRange but uses actual pre-nature min/max from Monte Carlo data when available.
// statsEntry: the per-species entry from currentStats (may be null). Falls back to calcStatRange.
function calcStatRangeActual(base, level, isHP, stat, statsEntry) {
	const data = statsEntry?.[stat];
	if (!data || isHP) return calcStatRange(base, level, isHP);
	// The bar tracks midpoint; label shows the full range including nature variation.
	const val = Math.round((data.min + data.max) / 2);
	return { val, lo: Math.floor(data.min * 0.9), hi: Math.floor(data.max * 1.1) };
}

// `max` sets the bar's full-scale value. Defaults to 200 for base stats (opponent cards);
// own-active cards pass a higher scale derived from real in-battle stats so they don't saturate.
// `display` overrides the label text (used to show "lo–hi" ranges for opponent cards).
function statBar(label, value, max = 200, display = null) {
	const cap = max * 0.75;
	const pct = Math.min(100, Math.round((value / max) * 100));
	const hue = Math.round((Math.min(value, cap) / cap) * 120); // red -> green
	return `<div class="stat"><span class="stat-l">${label}</span>`
		+ `<span class="stat-bar"><i style="width:${pct}%;background:hsl(${hue} 70% 45%)"></i></span>`
		+ `<span class="stat-v">${display ?? value}</span></div>`;
}

function typeTags(types) {
	return types.map((t) => `<span class="type t-${esc(t.toLowerCase())}">${esc(t)}</span>`).join('');
}

function moveChip(m, hideFreq = false) {
	const cat = esc(m.category.toLowerCase());
	const bp = m.basePower ? ` ${m.basePower}` : '';
	const freqSuffix = m.freq != null ? ` · ${m.freq}% of sets` : '';
	const freqBadge = (!hideFreq && m.freq != null) ? ` <span class="muted">${m.freq}%</span>` : '';
	// `used` (set by lookup) marks a predicted move the opponent has already revealed.
	return `<span class="move cat-${cat}${m.used ? ' used' : ''}" title="${esc(m.category)} · ${esc(m.type)}${bp ? ' · ' + m.basePower + ' BP' : ''}${m.used ? ' · seen' : ''}${freqSuffix}">`
		+ `<span class="type t-${esc(m.type.toLowerCase())}">${esc(m.type)}</span>${esc(m.name)}${bp}`
		+ `<img class="cat-icon" src="icons/categories/${esc(m.category)}.png" alt="${esc(m.category)}">${freqBadge}</span>`;
}

function breakdownCard(species, reveal) {
	const b = getBreakdown(species, { pokedex: core.pokedex, moves: core.moves, sets: currentSets, items: currentItems, abilities: currentAbilities, teras: currentTeras, movesFreq: currentMovesFreq }, reveal?.moves);
	let stats = '';
	if (b.baseStats) {
		const level = reveal?.level || b.level;
		if (level) {
			// Use actual pre-nature stat ranges from MC data; fall back to the 84-EV approximation.
			const se = currentStats?.[b.id];
			const cs = {
				hp:  calcStatRange(b.baseStats.hp,  level, true),
				atk: calcStatRangeActual(b.baseStats.atk, level, false, 'atk', se),
				def: calcStatRangeActual(b.baseStats.def, level, false, 'def', se),
				spa: calcStatRangeActual(b.baseStats.spa, level, false, 'spa', se),
				spd: calcStatRangeActual(b.baseStats.spd, level, false, 'spd', se),
				spe: calcStatRangeActual(b.baseStats.spe, level, false, 'spe', se),
			};
			const scale = Math.max(255, ...Object.values(cs).map((r) => r.val));
			const disp = (r) => String(r.val);
			stats = `<div class="stats">${statBar('HP', cs.hp.val, scale, disp(cs.hp))}${statBar('Atk', cs.atk.val, scale, disp(cs.atk))}${statBar('Def', cs.def.val, scale, disp(cs.def))}`
				+ `${statBar('SpA', cs.spa.val, scale, disp(cs.spa))}${statBar('SpD', cs.spd.val, scale, disp(cs.spd))}${statBar('Spe', cs.spe.val, scale, disp(cs.spe))}</div>`;
		} else {
			stats = `<div class="stats">${statBar('HP', b.baseStats.hp)}${statBar('Atk', b.baseStats.atk)}${statBar('Def', b.baseStats.def)}`
				+ `${statBar('SpA', b.baseStats.spa)}${statBar('SpD', b.baseStats.spd)}${statBar('Spe', b.baseStats.spe)}</div>`;
		}
	}

	const known = [];
	if (reveal?.ability) known.push(`<b>Ability:</b> ${esc(reveal.ability)}`);
	if (reveal?.item) known.push(`<b>Item:</b> ${esc(reveal.item)}`);
	const knownLine = known.length ? `<div class="known">${known.join(' · ')}</div>` : '';

	// Predicted items — only when the real item hasn't been revealed yet.
	// build-data stores "no item" rolls as "(none)"; show that as a readable label.
	const itemLabel = (n) => (n === '(none)' ? 'No item' : n);
	const items = (!reveal?.item && b.predictedItems.length)
		? `<div class="row"><span class="k">Likely items</span> ${b.predictedItems.map((p) => `<span class="pill">${esc(itemLabel(p.item))} <span class="muted">${p.pct}%</span></span>`).join('')}</div>` : '';

	// Show predicted abilities (with Monte Carlo %) when the ability hasn't been revealed yet.
	// Fall back to plain ability names if no frequency data is available for this format.
	const abilities = !reveal?.ability && b.abilities.length
		? (b.predictedAbilities.length
			? `<div class="row"><span class="k">Likely abilities</span> ${b.predictedAbilities.map((p) => `<span class="pill">${esc(p.ability)} <span class="muted">${p.pct}%</span></span>`).join('')}</div>`
			: `<div class="row"><span class="k">Possible abilities</span> ${b.abilities.map((a) => `<span class="pill">${esc(a)}</span>`).join('')}</div>`)
		: '';
	// Tera: show Monte Carlo probabilities when available, else fall back to set-narrowed list.
	const teraChip = (t, pct) =>
		`<span class="pill"><span class="type t-${esc(t.toLowerCase())}">${esc(t)}</span>${pct != null ? ` <span class="muted">${pct}%</span>` : ''}</span>`;
	const teras = b.teraTypes.length
		? (b.predictedTeras.length
			? `<div class="row"><span class="k">Likely tera</span> ${b.predictedTeras.map((p) => teraChip(p.teraType, p.pct)).join('')}</div>`
			: `<div class="row"><span class="k">Tera</span> ${b.teraTypes.map((t) => teraChip(t, null)).join('')}</div>`)
		: '';

	let setsHtml;
	if (b.confirmed && b.relevantSets.length) {
		// All 4 moves revealed and set confirmed — show only the known moves, no probabilities.
		const confirmedSet = b.relevantSets[0];
		const knownMoves = confirmedSet.moves.filter((m) => m.used);
		setsHtml = `<div class="set confirmed">
			<div class="role">${esc(confirmedSet.role)}</div>
			<div class="moves">${knownMoves.map((m) => moveChip(m, true)).join('')}</div>
		</div>`;
	} else if (b.found && b.relevantSets.length) {
		const note = b.lowConfidence
			? `<div class="nodata">Revealed moves don't match any predicted set — showing closest by move overlap.</div>` : '';
		setsHtml = note + b.relevantSets.map((set) => {
			// Sort moves by freq descending (moves with no freq data sort to end).
			const sortedMoves = [...set.moves].sort((a, b) => (b.freq ?? -1) - (a.freq ?? -1));
			return `
			<div class="set">
				<div class="role">${esc(set.role)}${set.roleFreq != null ? ` <span class="match">${set.roleFreq}%</span>` : ''}${b.revealedCount ? ` <span class="match">${set.matchCount}/${b.revealedCount} seen</span>` : ''}</div>
				<div class="moves">${sortedMoves.map((m) => moveChip(m)).join('')}</div>
			</div>`;
		}).join('');
	} else {
		setsHtml = `<div class="nodata">No predicted-set data for this format.</div>`;
	}

	// Badge in the head once the revealed moves pin the set down to exactly one.
	const headTag = b.confirmed
		? `<span class="confirmed-tag">✓ set</span>`
		: (b.revealedCount && b.possibleCount && b.possibleCount < b.sets.length ? `<span class="match">${b.possibleCount} sets left</span>` : '');

	return `
		<article class="card${reveal?.fainted ? ' fainted' : ''}">
			<div class="card-head">
				<span class="name">${esc(b.name)}</span>
				${reveal?.fainted ? `<span class="fnt-tag">fnt</span>` : ''}
				${b.level ? `<span class="lvl">L${b.level}</span>` : ''}
				${headTag}
				<span class="types">${typeTags(b.types)}</span>
			</div>
			${knownLine}
			${items}
			${stats}
			${abilities}
			${teras}
			<div class="sets">${setsHtml}</div>
		</article>`;
}

const idOf = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function ownMove(id) {
	return core.moves[id] || { name: id, type: '???', category: 'Status', basePower: 0 };
}

// Card for one of YOUR active Pokemon. Unlike the opponent, we know the real set from
// |request| (myTeam), so we show actual stats/item/ability/moves rather than predictions.
function myActiveCard(p, team) {
	const dex = core.pokedex[idOf(p.species)] || null;
	const hpPct = Math.round(p.hp / (p.maxhp || 100) * 100);
	const st = team?.stats;
	// HP isn't in request.stats; the active mon's maxhp is the real HP stat for your side.
	// Scale bars to this mon's largest real stat (floor 255) so high final stats don't saturate.
	const scale = st ? Math.max(255, p.maxhp, st.atk, st.def, st.spa, st.spd, st.spe) : 255;
	const stats = st
		? `<div class="stats">${statBar('HP', p.maxhp, scale)}${statBar('Atk', st.atk, scale)}${statBar('Def', st.def, scale)}`
			+ `${statBar('SpA', st.spa, scale)}${statBar('SpD', st.spd, scale)}${statBar('Spe', st.spe, scale)}</div>`
		: '';

	const known = [];
	const ability = team?.ability || p.ability;
	if (ability) known.push(`<b>Ability:</b> ${esc(ability)}`);
	if (team?.item) known.push(`<b>Item:</b> ${esc(team.item)}`);
	const tera = team?.teraType || p.tera;
	if (tera) known.push(`<b>Tera:</b> ${esc(tera)}`);
	const knownLine = known.length ? `<div class="known">${known.join(' · ')}</div>` : '';

	const movesHtml = team?.moves?.length
		? `<div class="moves">${team.moves.map((id) => moveChip(ownMove(id))).join('')}</div>` : '';

	return `
		<article class="card mine-card">
			<div class="card-head">
				<span class="name">${esc(p.species)}</span>
				<span class="lvl">L${p.level}</span>
				<span class="hp">${hpPct}%${p.status ? ' ' + esc(p.status) : ''}</span>
				<span class="types">${typeTags(dex ? dex.types : [])}</span>
			</div>
			${knownLine}
			${stats}
			${movesHtml}
		</article>`;
}

function render() {
	const s = tracker.state;
	console.log('[PSH panel] render formatId=' + s.formatId + ' tier=' + s.tier + ' core=' + !!core);

	// Room torn down (user left/closed the battle): clear the stale board.
	if (s.closed) {
		$format.textContent = 'Waiting for next game…';
		$content.innerHTML = `<p class="hint">No active battle — waiting for the next game…</p>`;
		return;
	}
	$format.textContent = s.tier || s.formatId || 'Waiting for a battle…';

	if (!core || !s.formatId) {
		return;
	}

	const opp = opponentSide();
	const active = Object.values(s.active).filter((p) => p.side === opp && !p.fainted);
	const activeIds = new Set(active.map((p) => idOf(p.species)));

	// Opponent's revealed-but-benched Pokemon (seen, not currently on the field).
	// Fainted mons sort to the bottom — they can't come back, so they're least relevant.
	const bench = Object.entries(s.revealed[opp] || {}).filter(([id]) => !activeIds.has(id));
	bench.sort(([, a], [, b]) => (a.fainted === b.fainted ? 0 : a.fainted ? 1 : -1));

	const myActive = Object.values(s.active).filter((p) => p.side === s.mySide && !p.fainted);
	const myById = {};
	for (const t of s.myTeam) myById[idOf(t.species)] = t;

	let html = '';
	if (s.ended) html += `<div class="banner">Battle over — final board</div>`;

	if (myActive.length) {
		html += `<section><h2>Your active</h2>`
			+ myActive.map((p) => myActiveCard(p, myById[idOf(p.species)])).join('')
			+ `</section>`;
	}

	html += `<section><h2>Opponent active</h2>`;
	html += active.length
		? active.map((p) => breakdownCard(p.species, s.revealed[opp]?.[idOf(p.species)])).join('')
		: `<p class="hint">No opponent Pokémon on the field yet.</p>`;
	html += `</section>`;

	if (bench.length) {
		html += `<section><h2>Opponent revealed (bench)</h2>`;
		html += bench.map(([, rec]) => breakdownCard(rec.species, rec)).join('');
		html += `</section>`;
	}

	$content.innerHTML = html;
}

// --- wire up data flow --------------------------------------------------------

// Live frames come via postMessage from the parent content script.
// (Using postMessage instead of runtime.onMessage because this panel is loaded
// inside an iframe embedded in the PS page — postMessage is reliable in all browsers
// for this cross-context setup.)
window.addEventListener('message', (event) => {
	if (event.data?.type === 'ps-frame') {
		const isBattle = typeof event.data.data === 'string' && event.data.data.startsWith('>battle-');
		const wasEnded = tracker.state.ended;
		const wasClosed = tracker.state.closed;
		tracker.feed(event.data.data);
		const s = tracker.state;
		if (isBattle) {
			console.log('[PSH panel] ps-frame recv (battle) → state formatId=' + s.formatId +
				' tier=' + s.tier + ' mySide=' + s.mySide + ' activeCount=' + Object.keys(s.active).length);
		}
		// Auto-download on clean end (|win|/|tie|) OR on rage-quit/close (|deinit|, turn >= 1).
		const justEnded = !wasEnded && s.ended;
		const justClosed = !wasClosed && s.closed && s.turn >= 1;
		if ((justEnded || justClosed) && s.roomid && !downloadedRooms.has(s.roomid)) {
			downloadedRooms.add(s.roomid);
			triggerDownload(s);
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
	// If the replayed battle ended or was rage-quit and we haven't downloaded it yet, do so now.
	// This covers the case where the panel was closed when |win|/|tie|/|deinit| arrived.
	const s = tracker.state;
	if ((s.ended || (s.closed && s.turn >= 1)) && s.roomid && !downloadedRooms.has(s.roomid)) {
		downloadedRooms.add(s.roomid);
		triggerDownload(s);
	}
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
