// Smoke test for the shared renderer (extension/lib/render.js) — the single source of truth shared by
// the Chrome extension panel and the showdown-ui Electron renderer. Drives a controlled mid-battle
// state through BattleTracker -> renderBattle and asserts the parity-feature markers are present so a
// regression in either consumer is caught in CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BattleTracker } from '../extension/lib/parser.js';
import { resolveSetsKey } from '../extension/lib/lookup.js';
import { renderBattle, waitingHtml } from '../extension/lib/render.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'extension', 'data');
const load = (p) => JSON.parse(readFileSync(join(DATA, p), 'utf8'));

const core = {
	pokedex: load('pokedex.json'),
	moves: load('moves.json'),
	abilitiesDesc: load('abilities-desc.json'),
};

function fmtFor(formatId) {
	const key = resolveSetsKey(formatId);
	const opt = (p) => { try { return load(p); } catch { return null; } };
	return {
		sets: opt(`sets/${key}.json`),
		items: opt(`items/${key}.json`),
		abilities: opt(`abilities/${key}.json`),
		teras: opt(`tera/${key}.json`),
		movesFreq: opt(`moves-freq/${key}.json`),
		stats: opt(`stats/${key}.json`),
	};
}

// Mid-battle: own Garchomp active (from |request|), opponent Gengar active at partial HP with no
// revealed ability — exercises every parity feature at once.
const FRAMES = [
	'>battle-gen9randombattle-1',
	'|init|battle',
	'|player|p1|You|1|',
	'|player|p2|Rival|2|',
	'|gametype|singles',
	'|gen|9',
	'|tier|[Gen 9] Random Battle',
	'|request|{"side":{"id":"p1","name":"You","pokemon":[{"ident":"p1: Garchomp","details":"Garchomp, L50, M","condition":"356/356","active":true,"stats":{"atk":200,"def":150,"spa":120,"spd":130,"spe":180},"moves":["earthquake","dragonclaw","swordsdance","firefang"],"baseAbility":"roughskin","item":"lifeorb","ability":"roughskin"}]}}',
	'|start',
	'|switch|p1a: Garchomp|Garchomp, L50, M|356/356',
	'|switch|p2a: Gengar|Gengar, L84, M|262/262',
	'|turn|1',
	'|move|p1a: Garchomp|Earthquake|p2a: Gengar',
	'|-damage|p2a: Gengar|131/262',
];

test('renderBattle emits the parity-feature markers', () => {
	const t = new BattleTracker();
	for (const f of FRAMES) t.feed(f);
	const { format, html } = renderBattle(t.state, core, fmtFor(t.state.formatId));

	assert.match(format, /Random Battle/);
	// Stat range bars (opponent) — the solid fill plus the lo→hi translucent "fuzzy tip".
	assert.match(html, /class="stat-bar"/);
	assert.match(html, /<u style/);
	// Live HP% (+ status) badge on active cards.
	assert.match(html, /class="hp"/);
	// Ability descriptions render as stacked ability pills for the unrevealed opponent ability.
	assert.match(html, /class="pill ability-pill"/);
	// Opponent live HP — Gengar at 131/262 ≈ 50%.
	assert.match(html, /50%/);
	// No redundant level label on cards (intentionally dropped in the canonical renderer).
	assert.doesNotMatch(html, /class="lvl"/);
});

test('assetBase prefixes the category-icon src; default is extension-relative', () => {
	const t = new BattleTracker();
	for (const f of FRAMES) t.feed(f);
	const def = renderBattle(t.state, core, fmtFor(t.state.formatId));
	assert.match(def.html, /src="icons\/categories\//);
	const based = renderBattle(t.state, core, fmtFor(t.state.formatId), { assetBase: '/base/' });
	assert.match(based.html, /src="\/base\/icons\/categories\//);
});

test('waitingHtml / closed state', () => {
	assert.match(waitingHtml(), /waiting for the next game/i);
	const { html } = renderBattle({ closed: true }, core, fmtFor(null));
	assert.match(html, /waiting for the next game/i);
});

test('waitingHtml shows the dead-tap banner only when warned (A2)', () => {
	// No-arg keeps the plain waiting state (no banner).
	assert.doesNotMatch(waitingHtml(), /banner--warn/);
	// A tap-warning prepends a visible banner so a broken tap isn't read as "no battle yet".
	const warned = waitingHtml('framing');
	assert.match(warned, /class="banner banner--warn"/);
	assert.match(warned, /Battle data unavailable/i);
	// renderBattle threads opts.tapWarning into the waiting branch.
	const { html } = renderBattle({ closed: true }, core, fmtFor(null), { tapWarning: 'no-socket' });
	assert.match(html, /banner--warn/);
});
