// Shared pure renderer for the battle-help panel — the single source of truth for the HTML the
// helper UI shows. Consumed by BOTH the Chrome extension panel (helper/extension/panel.js) and the
// showdown-ui Electron renderer (showdown-ui/src/lib/render.ts, a thin adapter). Keep it dependency-free
// (no DOM, no chrome/browser APIs, no Node, no import.meta) so every consumer can import it — same
// invariant as parser.js / lookup.js / exporter.js.
//
// All builders take (state, core, fmt) explicitly. The one environment-specific bit — the base path for
// category icons — is supplied per-call via renderBattle(..., { assetBase }); '' yields the extension's
// relative "icons/categories/…", showdown-ui passes its Vite BASE_URL.

import { getBreakdown } from './lookup.js';

// Set at the top of renderBattle from opts.assetBase; read by moveChip (the only icon consumer, always
// reached through renderBattle). Module-scoped because rendering is synchronous and single-threaded.
let _assetBase = '';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
	{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const idOf = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function opponentSide(state) {
	const me = state.mySide;
	if (me) return me === 'p1' ? 'p2' : 'p1';
	return 'p2';
}

// True when watching someone else's battle — no |request| ever arrives so mySide stays null,
// but players and revealed data for both sides are still populated.
function isSpectating(s) {
	return s.mySide === null && s.formatId !== null;
}

// Format detection mirroring the PS client (battle-tooltips.ts getSpeedRange). Random-battle
// formats assume neutral nature + ≤84 EVs; everything else allows ±nature + 252 EVs.
function formatMeta(s) {
	const tier = String(s?.tier ?? '');
	const fid = String(s?.formatId ?? '');
	const isRandbat = /Random Battle/i.test(tier) || /Computer-Generated Teams/i.test(tier) || /random/.test(fid);
	const gm = fid.match(/^gen(\d+)/) || tier.match(/Gen\s*(\d+)/i);
	return { isRandbat, gen: gm ? Number(gm[1]) : 9 };
}

// Opponent stat range, ported from the PS client's getSpeedRange (battle-tooltips.ts) and
// generalized from Speed to every stat, so the panel matches the "Spe X or Y" the PS hover shows.
// `lo` always assumes 0 IV / 0 EV; `hi` assumes max IV + the format's max EVs. Random battles use a
// neutral nature and an 84-EV cap; standard formats use ±nature and 252 EVs.
function statBounds(base, level, isHP, isRandbat, gen) {
	const tr = Math.trunc;
	const maxIv = gen < 3 ? 30 : 31;
	// Gen 1-2 have no nature and always allow full stat experience (offset 63), even in randbats.
	const evMaxOffset = gen < 3 ? 63 : (isRandbat ? 21 : 63); // floor(84/4)=21 ; floor(252/4)=63
	if (isHP) {
		if (base === 1) return { lo: 1, hi: 1 }; // Shedinja
		const lo = tr(2 * base * level / 100) + level + 10;
		const hi = tr((2 * base + maxIv + evMaxOffset) * level / 100) + level + 10;
		return { lo, hi };
	}
	const minNature = (isRandbat || gen < 3) ? 1 : 0.9;
	const maxNature = (isRandbat || gen < 3) ? 1 : 1.1;
	const lo = tr(tr(2 * base * level / 100 + 5) * minNature);
	const hi = tr(tr((2 * base + maxIv + evMaxOffset) * level / 100 + 5) * maxNature);
	return { lo, hi };
}

// `max` sets the bar's full-scale value. `display` overrides the label text.
function statBar(label, value, max = 200, display = null) {
	const cap = max * 0.75;
	const pct = Math.min(100, Math.round((value / max) * 100));
	const hue = Math.round((Math.min(value, cap) / cap) * 120); // red -> green
	return `<div class="stat"><span class="stat-l">${label}</span>`
		+ `<span class="stat-bar"><i style="width:${pct}%;background:hsl(${hue} 70% 45%)"></i></span>`
		+ `<span class="stat-v">${display ?? value}</span></div>`;
}

// Like statBar but the value is only known to a guaranteed range [lo, hi] (opponents). Reads the same
// as statBar — a solid fill from 0 — so the bar length still encodes magnitude. The lo→hi uncertainty
// is a lighter translucent segment layered on the end (the "fuzzy tip"); when lo === hi it's just a
// solid bar, no detached sliver. Label text shows "lo–hi" (or a single number when lo === hi).
function statRangeBar(label, lo, hi, max = 200) {
	const cap = max * 0.75;
	const loPct = Math.min(100, Math.round((lo / max) * 100));
	const hiPct = Math.min(100, Math.round((hi / max) * 100));
	const extPct = Math.max(hiPct - loPct, 0); // translucent extension width (0 when lo === hi)
	const hue = Math.round((Math.min(hi, cap) / cap) * 120); // red -> green, keyed on the high end
	const disp = lo === hi ? String(lo) : `${lo}–${hi}`;
	return `<div class="stat"><span class="stat-l">${label}</span>`
		+ `<span class="stat-bar"><i style="width:${loPct}%;background:hsl(${hue} 70% 45%)"></i>`
		+ `<u style="width:${extPct}%;background:hsl(${hue} 70% 45%)"></u></span>`
		+ `<span class="stat-v">${disp}</span></div>`;
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
		+ `<img class="cat-icon" src="${_assetBase}icons/categories/${esc(m.category)}.png" alt="${esc(m.category)}">${freqBadge}</span>`;
}

function breakdownCard(species, reveal, core, fmt, meta, activeHp = null) {
	const b = getBreakdown(species, { pokedex: core.pokedex, moves: core.moves, sets: fmt.sets, items: fmt.items, abilities: fmt.abilities, teras: fmt.teras, movesFreq: fmt.movesFreq }, reveal?.moves);
	const abilityDesc = (name) => core.abilitiesDesc?.[idOf(name)]?.description ?? '';
	let stats = '';
	if (b.baseStats) {
		const level = reveal?.level || b.level;
		if (level) {
			// Opponent stats are only known to a range. Show the same span the PS hover tooltip does,
			// using that format's spread rules (random battles: neutral nature + ≤84 EVs).
			const { isRandbat, gen } = meta;
			const cs = {
				hp:  statBounds(b.baseStats.hp,  level, true,  isRandbat, gen),
				atk: statBounds(b.baseStats.atk, level, false, isRandbat, gen),
				def: statBounds(b.baseStats.def, level, false, isRandbat, gen),
				spa: statBounds(b.baseStats.spa, level, false, isRandbat, gen),
				spd: statBounds(b.baseStats.spd, level, false, isRandbat, gen),
				spe: statBounds(b.baseStats.spe, level, false, isRandbat, gen),
			};
			const scale = Math.max(255, ...Object.values(cs).map((r) => r.hi));
			stats = `<div class="stats">${statRangeBar('HP', cs.hp.lo, cs.hp.hi, scale)}${statRangeBar('Atk', cs.atk.lo, cs.atk.hi, scale)}${statRangeBar('Def', cs.def.lo, cs.def.hi, scale)}`
				+ `${statRangeBar('SpA', cs.spa.lo, cs.spa.hi, scale)}${statRangeBar('SpD', cs.spd.lo, cs.spd.hi, scale)}${statRangeBar('Spe', cs.spe.lo, cs.spe.hi, scale)}</div>`;
		} else {
			stats = `<div class="stats">${statBar('HP', b.baseStats.hp)}${statBar('Atk', b.baseStats.atk)}${statBar('Def', b.baseStats.def)}`
				+ `${statBar('SpA', b.baseStats.spa)}${statBar('SpD', b.baseStats.spd)}${statBar('Spe', b.baseStats.spe)}</div>`;
		}
	}

	const known = [];
	if (reveal?.ability) known.push(`<b>Ability:</b> ${esc(reveal.ability)}`);
	if (reveal?.item) known.push(`<b>Item:</b> ${esc(reveal.item)}`);
	const knownLine = known.length ? `<div class="known">${known.join(' · ')}</div>` : '';
	// One-line description beneath the revealed ability.
	const revealedAbilityDesc = reveal?.ability ? core.abilitiesDesc?.[idOf(reveal.ability)]?.description : null;
	const abilityDescLine = revealedAbilityDesc ? `<div class="ability-desc">${esc(revealedAbilityDesc)}</div>` : '';

	// Predicted items — only when the real item hasn't been revealed yet.
	const itemLabel = (n) => (n === '(none)' ? 'No item' : n);
	const items = (!reveal?.item && b.predictedItems.length)
		? `<div class="row"><span class="k">Likely items</span> ${b.predictedItems.map((p) => `<span class="pill">${esc(itemLabel(p.item))} <span class="muted">${p.pct}%</span></span>`).join('')}</div>` : '';

	const abilityPill = (name, pct) => {
		const d = abilityDesc(name);
		const descHtml = d ? `<span class="ability-pill-desc">${esc(d)}</span>` : '';
		return `<span class="pill ability-pill">${esc(name)}${pct != null ? ` <span class="muted">${pct}%</span>` : ''}${descHtml}</span>`;
	};
	// Show predicted abilities (with Monte Carlo %) when the ability hasn't been revealed yet. The pills
	// carry a description each, so they're stacked vertically (.ability-list) rather than wrapped inline.
	const abilities = !reveal?.ability && b.abilities.length
		? (b.predictedAbilities.length
			? `<div class="row"><span class="k">Likely abilities</span><div class="ability-list">${b.predictedAbilities.map((p) => abilityPill(p.ability, p.pct)).join('')}</div></div>`
			: `<div class="row"><span class="k">Possible abilities</span><div class="ability-list">${b.abilities.map((a) => abilityPill(a)).join('')}</div></div>`)
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

	// Badge in the head once the revealed moves pin the set down — suppressed at possibleCount === 1,
	// since that lone set is already shown in full below the head, so the badge would be redundant.
	const headTag = b.confirmed
		? `<span class="confirmed-tag">✓ set</span>`
		: (b.revealedCount && b.possibleCount && b.possibleCount > 1 && b.possibleCount < b.sets.length ? `<span class="match">${b.possibleCount} sets left</span>` : '');

	// Opponent HP% (+ status) for the active Pokémon, when the caller passes live HP.
	const hpTag = activeHp
		? `<span class="hp">${Math.round(activeHp.hp / (activeHp.maxhp || 100) * 100)}%${activeHp.status ? ' ' + esc(activeHp.status) : ''}</span>`
		: '';

	return `
		<article class="card${reveal?.fainted ? ' fainted' : ''}">
			<div class="card-head">
				<span class="name">${esc(b.name)}</span>
				${reveal?.fainted ? `<span class="fnt-tag">fnt</span>` : ''}
				${hpTag}
				${headTag}
				<span class="types">${typeTags(b.types)}</span>
			</div>
			${knownLine}
			${abilityDescLine}
			${items}
			${stats}
			${abilities}
			${teras}
			<div class="sets">${setsHtml}</div>
		</article>`;
}

function ownMove(id, core) {
	return core.moves[id] || { name: id, type: '???', category: 'Status', basePower: 0 };
}

// Card for one of YOUR active Pokemon. We know the real set from |request| (myTeam),
// so we show actual stats/item/ability/moves rather than predictions.
function myActiveCard(p, team, core) {
	const dex = core.pokedex[idOf(p.species)] || null;
	const hpPct = Math.round(p.hp / (p.maxhp || 100) * 100);
	const st = team?.stats;
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
	const abilityDesc = ability ? core.abilitiesDesc?.[idOf(ability)]?.description : null;
	const abilityDescLine = abilityDesc ? `<div class="ability-desc">${esc(abilityDesc)}</div>` : '';

	const movesHtml = team?.moves?.length
		? `<div class="moves">${team.moves.map((id) => moveChip(ownMove(id, core))).join('')}</div>` : '';

	return `
		<article class="card mine-card">
			<div class="card-head">
				<span class="name">${esc(p.species)}</span>
				<span class="hp">${hpPct}%${p.status ? ' ' + esc(p.status) : ''}</span>
				<span class="types">${typeTags(dex ? dex.types : [])}</span>
			</div>
			${knownLine}
			${abilityDescLine}
			${stats}
			${movesHtml}
		</article>`;
}

export function waitingHtml(tapWarning) {
	// tapWarning (truthy) = the WebSocket tap is alive but sees no battle frames (dead socket / changed
	// SockJS framing). Lead with a visible banner so a broken tap isn't mistaken for "no battle yet".
	const banner = tapWarning
		? `<div class="banner banner--warn">Battle data unavailable — the connection tap saw no battle frames. Pokémon Showdown may have changed how it sends data; try reloading the page.</div>\n`
		: '';
	return `${banner}<p class="hint">No active battle — waiting for the next game…</p>
<div class="hint-box">
  <b>Having issues?</b>
  <ul>
    <li>Start or accept a battle in the window on the left to begin tracking.</li>
    <li>To watch someone else's battle, open it from the Battle Search tab — the panel shows both players' Pokémon.</li>
    <li>Battle logs are saved automatically to <code>logs/battle_info/</code> — no manual save needed.</li>
  </ul>
</div>`;
}

// Render one side's active + revealed bench as a labelled section block.
function renderSideHtml(s, side, label, core, fmt) {
	const meta = formatMeta(s);
	const active = Object.values(s.active).filter((p) => p.side === side && !p.fainted);
	const activeIds = new Set(active.map((p) => idOf(p.species)));
	const bench = Object.entries(s.revealed[side] || {}).filter(([id]) => !activeIds.has(id));
	bench.sort(([, a], [, b]) => (a.fainted === b.fainted ? 0 : a.fainted ? 1 : -1));

	let html = `<section><h2>${esc(label)} — active</h2>`;
	html += active.length
		? active.map((p) => breakdownCard(p.species, s.revealed[side]?.[idOf(p.species)], core, fmt, meta, { hp: p.hp, maxhp: p.maxhp, status: p.status })).join('')
		: `<p class="hint">No Pokémon on the field yet.</p>`;
	html += `</section>`;

	if (bench.length) {
		html += `<section><h2>${esc(label)} — bench</h2>`;
		html += bench.map(([, rec]) => breakdownCard(rec.species, rec, core, fmt, meta)).join('');
		html += `</section>`;
	}
	return html;
}

// Returns { format, html }. `opts.assetBase` prefixes the category-icon src ('' = extension-relative).
export function renderBattle(s, core, fmt, opts = {}) {
	_assetBase = opts.assetBase || '';

	// Room torn down (user left/closed the battle): clear the stale board.
	if (s.closed) {
		return { format: 'Waiting for next game…', html: waitingHtml(opts.tapWarning) };
	}
	const format = s.tier || s.formatId || 'Waiting for a battle…';

	if (!core || !s.formatId) {
		return { format, html: waitingHtml(opts.tapWarning) };
	}

	let html = '';

	if (isSpectating(s)) {
		// Spectator view — no |request| so no mySide; show both players' revealed data.
		const p1name = s.players.p1?.name || 'Player 1';
		const p2name = s.players.p2?.name || 'Player 2';
		if (s.ended) {
			const winnerLabel = s.winner ? `${esc(s.winner)} wins` : 'Tie';
			html += `<div class="banner">Battle over — ${winnerLabel}</div>`;
		}
		html += renderSideHtml(s, 'p1', p1name, core, fmt);
		html += renderSideHtml(s, 'p2', p2name, core, fmt);
		return { format, html };
	}

	const meta = formatMeta(s);
	const opp = opponentSide(s);
	const active = Object.values(s.active).filter((p) => p.side === opp && !p.fainted);
	const activeIds = new Set(active.map((p) => idOf(p.species)));

	// Opponent's revealed-but-benched Pokemon (fainted sort to the bottom).
	const bench = Object.entries(s.revealed[opp] || {}).filter(([id]) => !activeIds.has(id));
	bench.sort(([, a], [, b]) => (a.fainted === b.fainted ? 0 : a.fainted ? 1 : -1));

	const myActive = Object.values(s.active).filter((p) => p.side === s.mySide && !p.fainted);
	const myById = {};
	for (const t of s.myTeam) myById[idOf(t.species)] = t;

	if (s.ended) html += `<div class="banner">Battle over — final board</div>`;

	if (myActive.length) {
		html += `<section><h2>Your active</h2>`
			+ myActive.map((p) => myActiveCard(p, myById[idOf(p.species)], core)).join('')
			+ `</section>`;
	}

	html += `<section><h2>Opponent active</h2>`;
	html += active.length
		? active.map((p) => breakdownCard(p.species, s.revealed[opp]?.[idOf(p.species)], core, fmt, meta, { hp: p.hp, maxhp: p.maxhp, status: p.status })).join('')
		: `<p class="hint">No opponent Pokémon on the field yet.</p>`;
	html += `</section>`;

	if (bench.length) {
		html += `<section><h2>Opponent revealed (bench)</h2>`;
		html += bench.map(([, rec]) => breakdownCard(rec.species, rec, core, fmt, meta)).join('');
		html += `</section>`;
	}

	return { format, html };
}
