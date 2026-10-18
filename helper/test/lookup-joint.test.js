import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getBreakdown } from '../extension/lib/lookup.js';

// Synthetic species with one role and four generated combos. Row layout (see build-data.js):
// [itemIdx, abilityIdx, teraIdx|-1, count, ...moveIdx]
const dict = ['Leftovers', 'Life Orb', 'Overgrow', 'Chlorophyll', 'Steel', 'Dark', 'gigadrain', 'sludgebomb', 'knockoff', 'protect', 'leechseed'];
const joint = {
	venusaur: {
		dict,
		roles: {
			Support: {
				total: 100,
				other: 0,
				rows: [
					[0, 2, 4, 40, 6, 7, 10, 9], // Leftovers / Overgrow / Steel / gigadrain sludgebomb leechseed protect
					[0, 2, 5, 20, 6, 7, 8, 9],  // Leftovers / Overgrow / Dark  / gigadrain sludgebomb knockoff protect
					[1, 3, 5, 30, 6, 7, 8, 9],  // Life Orb  / Chlorophyll / Dark / ... knockoff
					[1, 3, 4, 10, 6, 7, 10, 9], // Life Orb  / Chlorophyll / Steel / ... leechseed
				],
			},
		},
	},
};
const pokedex = { venusaur: { name: 'Venusaur', num: 3, types: ['Grass', 'Poison'], baseStats: {}, abilities: { 0: 'Overgrow', H: 'Chlorophyll' } } };
const mv = (name) => ({ name, type: 'Grass', category: 'Special', basePower: 80, accuracy: 100, pp: 10 });
const moves = Object.fromEntries(['gigadrain', 'sludgebomb', 'knockoff', 'protect', 'leechseed'].map((m) => [m, mv(m)]));
const sets = {
	venusaur: {
		level: 84,
		sets: [{ role: 'Support', movepool: ['gigadrain', 'sludgebomb', 'knockoff', 'protect', 'leechseed'], abilities: ['Overgrow', 'Chlorophyll'], teraTypes: ['Steel', 'Dark'] }],
	},
};
const data = { pokedex, moves, sets, joint };
const pct = (list, key, name) => list.find((x) => x[key] === name)?.pct ?? 0;

test('without facts the joint marginals match the raw tallies', () => {
	const b = getBreakdown('Venusaur', data);
	assert.equal(pct(b.predictedItems, 'item', 'Leftovers'), 60);
	assert.equal(pct(b.predictedTeras, 'teraType', 'Steel'), 50);
	assert.equal(b.joint.combos, 4);
	assert.equal(b.joint.relaxed, false);
});

test('a revealed move eliminates incompatible combos and reweights the rest', () => {
	const b = getBreakdown('Venusaur', data, ['knockoff']);
	assert.equal(b.joint.combos, 2);
	assert.equal(pct(b.predictedTeras, 'teraType', 'Steel'), 0); // knockoff never rolls with Steel
	assert.equal(pct(b.predictedTeras, 'teraType', 'Dark'), 100);
	assert.equal(pct(b.predictedItems, 'item', 'Life Orb'), 60);
	assert.ok(!b.joint.predictedMoves.some((m) => m.move === 'knockoff')); // already revealed
	assert.equal(b.joint.predictedMoves.find((m) => m.move === 'leechseed'), undefined);
});

test('item, ability and tera facts chain: each fact narrows the others', () => {
	const b = getBreakdown('Venusaur', data, [], { item: 'Life Orb' });
	assert.equal(pct(b.predictedAbilities, 'ability', 'Chlorophyll'), 100);
	const b2 = getBreakdown('Venusaur', data, [], { ability: 'Overgrow', tera: 'Dark' });
	assert.equal(b2.joint.combos, 1);
	assert.equal(pct(b2.predictedItems, 'item', 'Leftovers'), 100);
	assert.equal(b2.joint.predictedMoves.find((m) => m.move === 'knockoff').pct, 100);
});

test('an impossible fact (swapped item) relaxes instead of collapsing', () => {
	const b = getBreakdown('Venusaur', data, ['leechseed'], { item: 'Choice Scarf', tera: 'Steel' });
	assert.equal(b.joint.relaxed, true);
	assert.ok(b.joint.combos > 0);
	assert.equal(pct(b.predictedTeras, 'teraType', 'Steel'), 100); // tera + moves still honored
});

test('no joint data falls back to role-level predictions', () => {
	const items = { venusaur: { Support: { Leftovers: 3, 'Life Orb': 1 } } };
	const b = getBreakdown('Venusaur', { ...data, joint: null, items }, ['knockoff'], { item: 'Life Orb' });
	assert.equal(b.joint, null);
	assert.equal(pct(b.predictedItems, 'item', 'Leftovers'), 75);
});

test('percentages from the joint path sum to 100', () => {
	const b = getBreakdown('Venusaur', data);
	assert.equal(b.predictedItems.reduce((s, x) => s + x.pct, 0), 100);
	assert.equal(b.predictedTeras.reduce((s, x) => s + x.pct, 0), 100);
});
