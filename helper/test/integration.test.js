// End-to-end: raw protocol frame -> tracker -> lookup, mirroring what panel.js does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BattleTracker } from '../extension/lib/parser.js';
import { resolveSetsKey, getBreakdown } from '../extension/lib/lookup.js';
import { toID } from '../extension/lib/toid.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'extension', 'data');
const load = (p) => JSON.parse(readFileSync(join(DATA, p), 'utf8'));
const pokedex = load('pokedex.json');
const moves = load('moves.json');

const FRAME = [
	'>battle-gen9randomdoublesbattle-42',
	'|gen|9', '|gametype|doubles', '|tier|[Gen 9] Random Doubles Battle',
	'|player|p1|Me|1|', '|player|p2|Opp|2|',
	'|switch|p2a: Swampert|Swampert, L82, M|100/100',
	'|switch|p2b: Charizard|Charizard, L82, M|100/100',
	'|switch|p1a: Pikachu|Pikachu, L88, M|100/100',
	'|-item|p2a: Swampert|Leftovers',
	'|switch|p2a: Amoonguss|Amoonguss, L84, F|100/100', // Swampert leaves -> goes to bench
	'|turn|2',
].join('\n');

test('panel pipeline: opponent active + bench breakdowns', () => {
	const t = new BattleTracker();
	t.feed(FRAME);
	// We are p1; mySide is unknown without a request, so the panel defaults opponent to p2.
	const opp = 'p2';
	const sets = load(`${resolveSetsKey(t.state.formatId)}.json`.replace(/^/, 'sets/'));

	const active = Object.values(t.state.active).filter((p) => p.side === opp && !p.fainted);
	const activeIds = new Set(active.map((p) => toID(p.species)));
	assert.deepEqual(active.map((p) => p.species).sort(), ['Amoonguss', 'Charizard']);

	const bench = Object.entries(t.state.revealed[opp]).filter(([id]) => !activeIds.has(id));
	assert.deepEqual(bench.map(([id]) => id), ['swampert']); // revealed, now benched

	// Active breakdown resolves correctly.
	const charizard = getBreakdown('Charizard', { pokedex, moves, sets });
	assert.equal(charizard.found, true);
	assert.deepEqual(charizard.types, ['Fire', 'Flying']);
	assert.ok(charizard.sets[0].moves.length > 0);

	// Benched Swampert keeps its revealed item.
	const swampReveal = t.state.revealed[opp].swampert;
	assert.equal(swampReveal.item, 'Leftovers');
});
