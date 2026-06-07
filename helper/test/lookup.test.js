import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolveSetsKey, getBreakdown } from '../extension/lib/lookup.js';
import { toID } from '../extension/lib/toid.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'extension', 'data');
const load = (p) => JSON.parse(readFileSync(join(DATA, p), 'utf8'));

const pokedex = load('pokedex.json');
const moves = load('moves.json');

test('resolveSetsKey maps random formats, rejects others', () => {
	assert.equal(resolveSetsKey('gen9randombattle'), 'gen9');
	assert.equal(resolveSetsKey('gen9randomdoublesbattle'), 'gen9doubles');
	assert.equal(resolveSetsKey('gen1randombattle'), 'gen1');
	assert.equal(resolveSetsKey('gen9ou'), null);
	assert.equal(resolveSetsKey('gen9vgc2024'), null);
});

test('getBreakdown for Swampert in gen9 doubles randbats', () => {
	const sets = load('sets/gen9doubles.json');
	const b = getBreakdown('Swampert', { pokedex, moves, sets });
	assert.equal(b.found, true);
	assert.equal(b.name, 'Swampert');
	assert.deepEqual(b.types, ['Water', 'Ground']);
	assert.equal(b.baseStats.atk, 110);
	assert.ok(b.level > 0);
	// Movepool from doubles-sets.json, resolved to full move info.
	const moveNames = b.sets.flatMap((s) => s.moves.map((m) => m.id));
	assert.ok(moveNames.includes('flipturn'));
	const flip = b.sets[0].moves.find((m) => m.id === 'flipturn');
	assert.equal(flip.type, 'Water');
	assert.equal(flip.category, 'Physical');
});

test('getBreakdown still returns dex info when no set data exists', () => {
	const sets = {};
	const b = getBreakdown('Charizard', { pokedex, moves, sets });
	assert.equal(b.found, false);
	assert.deepEqual(b.types, ['Fire', 'Flying']);
	assert.deepEqual(b.abilities, ['Blaze', 'Solar Power']); // falls back to dex abilities
});

test('revealed moves flag used chips and keep matching sets possible', () => {
	const sets = load('sets/gen9.json');
	const items = load('items/gen9.json');
	const sampleId = toID(sets.gholdengo.sets[0].movepool[0]);
	const b = getBreakdown('Gholdengo', { pokedex, moves, sets, items }, new Set([sampleId]));
	assert.equal(b.revealedCount, 1);
	// The revealed move is highlighted in the set that lists it.
	assert.equal(b.sets[0].moves.find((m) => m.id === sampleId).used, true);
	// At least the set containing the move survives narrowing, and none becomes "impossible-only".
	assert.ok(b.relevantSets.length >= 1);
	assert.equal(b.lowConfidence, false);
});

test('a revealed move in no set flags low confidence and keeps all sets', () => {
	const sets = load('sets/gen9.json');
	// Frenzy Plant is a Grass move Gholdengo (Steel/Ghost) never runs.
	const b = getBreakdown('Gholdengo', { pokedex, moves, sets }, new Set(['frenzyplant']));
	assert.equal(b.lowConfidence, true);
	assert.equal(b.relevantSets.length, b.sets.length);
});

test('predicted items return top-3 with sane percentages', () => {
	const sets = load('sets/gen9.json');
	const items = load('items/gen9.json');
	const b = getBreakdown('Gholdengo', { pokedex, moves, sets, items });
	assert.ok(b.predictedItems.length > 0 && b.predictedItems.length <= 3);
	assert.ok(b.predictedItems.every((p) => p.pct > 0 && p.pct <= 100));
	// No item data supplied -> no predictions, but the breakdown still builds.
	const b2 = getBreakdown('Gholdengo', { pokedex, moves, sets });
	assert.deepEqual(b2.predictedItems, []);
});

test('getBreakdown adapts gen1 data.json shape', () => {
	const sets = load('sets/gen1.json');
	const b = getBreakdown('Tauros', { pokedex, moves, sets });
	assert.equal(b.found, true);
	assert.equal(b.sets.length, 1);
	assert.equal(b.sets[0].role, 'Random Set');
	assert.ok(b.sets[0].moves.length > 0);
});

test('sets with identical movepools are merged into one with combined role name', () => {
	const sets = load('sets/gen9.json');
	// GreatTusk has "Fast Bulky Setup" and "Bulky Setup" which share the same movepool.
	const b = getBreakdown('Great Tusk', { pokedex, moves, sets });
	assert.equal(b.found, true);
	// 2 duplicate sets collapse to 1; "Bulky Support" remains separate → 2 total.
	assert.equal(b.sets.length, 2);
	const merged = b.sets.find((s) => s.role.includes('/'));
	assert.ok(merged, 'a merged set with / in the role name should exist');
	assert.ok(merged.role.includes('Fast Bulky Setup') && merged.role.includes('Bulky Setup'));
	// The merged set's _roles should list both original names for data lookups.
	assert.deepEqual(new Set(merged._roles), new Set(['Fast Bulky Setup', 'Bulky Setup']));
	// Abilities and tera types should be the union of both source sets.
	assert.ok(merged.abilities.length > 0);
	assert.ok(merged.teraTypes.length > 0);
});

test('predicted abilities return top-3 with sane percentages', () => {
	const sets = load('sets/gen9.json');
	const abilities = load('abilities/gen9.json');
	const b = getBreakdown('Gholdengo', { pokedex, moves, sets, abilities });
	assert.ok(b.predictedAbilities.length > 0 && b.predictedAbilities.length <= 3);
	assert.ok(b.predictedAbilities.every((p) => p.pct > 0 && p.pct <= 100));
	// No ability data supplied -> no predictions, but breakdown still builds.
	const b2 = getBreakdown('Gholdengo', { pokedex, moves, sets });
	assert.deepEqual(b2.predictedAbilities, []);
});

test('predicted abilities sharpen as reveals narrow relevant sets (GreatTusk)', () => {
	const sets = load('sets/gen9.json');
	const abilities = load('abilities/gen9.json');
	// Revealing "stealthrock" pins GreatTusk to the Bulky Support set (only set with that move).
	const bNarrow = getBreakdown('Great Tusk', { pokedex, moves, sets, abilities }, new Set(['stealthrock']));
	assert.equal(bNarrow.relevantSets.length, 1);
	assert.ok(bNarrow.predictedAbilities.length > 0);
	// Probabilities must still sum to ≤100% (rounding may produce 99/100/101).
	const total = bNarrow.predictedAbilities.reduce((s, p) => s + p.pct, 0);
	assert.ok(total >= 95 && total <= 105, `pct sum ${total} out of range`);
});

test('predicted items still work correctly for merged sets', () => {
	const sets = load('sets/gen9.json');
	const items = load('items/gen9.json');
	// GreatTusk's two duplicate sets merge; item predictions should tally both original roles.
	const b = getBreakdown('Great Tusk', { pokedex, moves, sets, items });
	assert.ok(b.predictedItems.length > 0 && b.predictedItems.length <= 3);
	assert.ok(b.predictedItems.every((p) => p.pct > 0 && p.pct <= 100));
});
