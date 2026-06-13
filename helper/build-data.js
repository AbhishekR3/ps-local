// Builds the static JSON data bundle the extension ships with.
//
// Sources everything from the vendored pokemon-showdown submodule (../vendor/pokemon-showdown):
//   - data/pokedex.ts, data/moves.ts  -> trimmed JSON (imported directly; Node strips the TS types)
//   - data/random-battles/**/(sets|doubles-sets|data).json -> copied as sets/<key>.json
//   - dist/sim/teams (COMPILED) -> Monte-Carlo item-frequency tables under items/<key>.json
//
// Output: helper/extension/data/
//
// PREREQUISITE: run `npm run build` in the repo root first — the item step requires the
// compiled simulator at dist/sim/. (pokedex/moves import the .ts directly since Node strips
// data-only TS types, but teams.ts has real logic and must be compiled.)
//
// Re-run this whenever the upstream PS data changes:  npm run build && node build-data.js
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
// ps-local: helper/ is a sibling of vendor/, so the server submodule is ../vendor/pokemon-showdown
const REPO = join(HERE, '..', 'vendor', 'pokemon-showdown');
const OUT = join(HERE, 'extension', 'data');
const OUT_SETS = join(OUT, 'sets');
const OUT_ITEMS = join(OUT, 'items');
const OUT_ABILITIES = join(OUT, 'abilities');
const OUT_TERAS = join(OUT, 'tera');
const OUT_STATS = join(OUT, 'stats');
const OUT_MOVES_FREQ = join(OUT, 'moves-freq');

mkdirSync(OUT_SETS, { recursive: true });
mkdirSync(OUT_ITEMS, { recursive: true });
mkdirSync(OUT_ABILITIES, { recursive: true });
mkdirSync(OUT_TERAS, { recursive: true });
mkdirSync(OUT_STATS, { recursive: true });
mkdirSync(OUT_MOVES_FREQ, { recursive: true });

// --- Pokedex: keep only what the breakdown UI needs ---------------------------
const { Pokedex } = await import(join(REPO, 'data', 'pokedex.ts'));
const pokedex = {};
for (const id in Pokedex) {
	const s = Pokedex[id];
	pokedex[id] = {
		name: s.name,
		num: s.num,
		types: s.types,
		baseStats: s.baseStats,
		abilities: s.abilities,
		// Cosmetic/alternate formes (Maushold-Four, Tatsugiri-Stretchy, …) carry no random-battle set
		// data of their own; baseSpecies lets lookup.js fall back to the base form's sets. Only present
		// on forme entries upstream — base species leave it undefined, which we omit below.
		...(s.baseSpecies && s.baseSpecies !== s.name ? { baseSpecies: s.baseSpecies } : {}),
	};
}
writeFileSync(join(OUT, 'pokedex.json'), JSON.stringify(pokedex));
console.log(`pokedex.json: ${Object.keys(pokedex).length} species`);

// --- Moves: per-move display info for the predicted movepool ------------------
const { Moves } = await import(join(REPO, 'data', 'moves.ts'));
const moves = {};
for (const id in Moves) {
	const m = Moves[id];
	moves[id] = {
		name: m.name,
		type: m.type,
		category: m.category,
		basePower: m.basePower,
		accuracy: m.accuracy,
		pp: m.pp,
	};
}
writeFileSync(join(OUT, 'moves.json'), JSON.stringify(moves));
console.log(`moves.json: ${Object.keys(moves).length} moves`);

// --- Random-battle sets: copy verbatim under a predictable key ----------------
// Key scheme matches resolveSetsKey() in src/lookup.js:
//   genN            -> data/random-battles/genN/sets.json   (gen1 uses data.json)
//   genNdoubles     -> data/random-battles/genN/doubles-sets.json
const RB = join(REPO, 'data', 'random-battles');
const available = [];

function copySets(key, srcRelPath) {
	const src = join(RB, srcRelPath);
	if (!existsSync(src)) return;
	writeFileSync(join(OUT_SETS, `${key}.json`), readFileSync(src));
	available.push(key);
}

for (let gen = 1; gen <= 9; gen++) {
	// gen1 stores its sets in data.json with a different shape; lookup adapts it.
	copySets(`gen${gen}`, `gen${gen}/${gen === 1 ? 'data.json' : 'sets.json'}`);
	copySets(`gen${gen}doubles`, `gen${gen}/doubles-sets.json`);
}

writeFileSync(join(OUT, 'formats.json'), JSON.stringify(available));
console.log(`sets: ${available.length} files -> ${available.join(', ')}`);

// --- Predicted items + abilities: Monte-Carlo the real team generator -----------
// Random-battle items and abilities aren't stored statically — they're chosen at generation
// time. We run the actual generator many times per species and tally what it picks, keyed by
// role so predictions sharpen once revealed moves narrow the set (lookup.js).
const ROUNDS = 200;

// "gen9" -> singles, "gen9doubles" -> doubles. Returns null for non-standard keys.
function keyToFormat(key) {
	const m = key.match(/^gen(\d+)(doubles)?$/);
	if (!m) return null;
	const gen = Number(m[1]);
	const isDoubles = !!m[2];
	return { gen, isDoubles, format: `gen${gen}random${isDoubles ? 'doubles' : ''}battle` };
}

const teamsMod = await import(join(REPO, 'dist', 'sim', 'teams.js'));
const Teams = teamsMod.Teams || teamsMod.default?.Teams;
if (!Teams?.getGenerator) {
	console.warn('items/abilities: dist/sim/teams not found — run `npm run build` first. Skipping tables.');
} else {
	const itemKeys = [];
	const abilityKeys = [];
	const teraKeys = [];
	const statsKeys = [];
	const movesFreqKeys = [];
	for (const key of available) {
		const meta = keyToFormat(key);
		if (!meta) continue;
		let gen;
		try {
			gen = Teams.getGenerator(meta.format, [1, 2, 3, 4]);
		} catch {
			continue;
		}
		if (typeof gen.randomSet !== 'function') continue; // older gens use a different shape

		const speciesIds = Object.keys(JSON.parse(readFileSync(join(OUT_SETS, `${key}.json`), 'utf8')));
		const isDynamax = meta.gen === 8 && !meta.isDoubles;
		const itemOut = {};
		const abilityOut = {};
		const teraOut = {};
		const statsOut = {};
		const movesFreqOut = {};
		for (const id of speciesIds) {
			const itemRoles = {};
			const abilityRoles = {};
			const teraRoles = {};
			let sawItem = false;
			let sawAbility = false;
			let sawTera = false;
			const statPre = {}; // pre-nature stat min/max from actual EVs/IVs
			// { role: { total: N, moves: { moveId: count } } }
			const moveFreqRoles = {};
			for (let i = 0; i < ROUNDS; i++) {
				gen.setSeed([i, i, i, i]);
				let set;
				try {
					// Empty teamDetails: weather/team-context items won't fire, but those are rare.
					set = gen.randomSet(id, {}, i % 6 === 2, meta.isDoubles, isDynamax);
				} catch {
					break; // this gen's generator doesn't support randomSet(species, …)
				}
				if (!set) continue;
				const role = set.role || 'Random Set';

				const item = set.item || '(none)';
				(itemRoles[role] = itemRoles[role] || {})[item] = (itemRoles[role][item] || 0) + 1;
				if (set.item) sawItem = true;

				const ability = set.ability || '(none)';
				(abilityRoles[role] = abilityRoles[role] || {})[ability] = (abilityRoles[role][ability] || 0) + 1;
				if (set.ability) sawAbility = true;
				if (set.teraType) {
					(teraRoles[role] = teraRoles[role] || {})[set.teraType] = (teraRoles[role][set.teraType] || 0) + 1;
					sawTera = true;
				}
				if (!moveFreqRoles[role]) moveFreqRoles[role] = { total: 0, moves: {} };
				moveFreqRoles[role].total++;
				for (const mv of (set.moves || [])) {
					const mid = String(mv).toLowerCase().replace(/[^a-z0-9]/g, '');
					moveFreqRoles[role].moves[mid] = (moveFreqRoles[role].moves[mid] || 0) + 1;
				}
				const evs = set.evs || {};
				const ivs = set.ivs || {};
				const level = set.level;
				const baseStats = Pokedex[id]?.baseStats;
				if (baseStats && level) {
					for (const stat of ['atk', 'def', 'spa', 'spd', 'spe']) {
						const base = baseStats[stat];
						if (base === undefined) continue;
						const iv = ivs[stat] ?? 31;
						const ev = evs[stat] ?? 0;
						const val = Math.floor((2 * base + iv + Math.floor(ev / 4)) * level / 100) + 5;
						if (!statPre[stat]) {
							statPre[stat] = { min: val, max: val };
						} else {
							if (val < statPre[stat].min) statPre[stat].min = val;
							if (val > statPre[stat].max) statPre[stat].max = val;
						}
					}
				}
			}
			if (sawItem) itemOut[id] = itemRoles;
			if (sawAbility) abilityOut[id] = abilityRoles;
			if (sawTera) teraOut[id] = teraRoles;
			if (Object.keys(statPre).length) statsOut[id] = statPre;
			if (Object.keys(moveFreqRoles).length) movesFreqOut[id] = moveFreqRoles;
		}
		if (Object.keys(itemOut).length) {
			writeFileSync(join(OUT_ITEMS, `${key}.json`), JSON.stringify(itemOut));
			itemKeys.push(key);
			console.log(`items/${key}.json: ${Object.keys(itemOut).length} species`);
		}
		if (Object.keys(abilityOut).length) {
			writeFileSync(join(OUT_ABILITIES, `${key}.json`), JSON.stringify(abilityOut));
			abilityKeys.push(key);
			console.log(`abilities/${key}.json: ${Object.keys(abilityOut).length} species`);
		}
		if (Object.keys(teraOut).length) {
			writeFileSync(join(OUT_TERAS, `${key}.json`), JSON.stringify(teraOut));
			teraKeys.push(key);
			console.log(`tera/${key}.json: ${Object.keys(teraOut).length} species`);
		}
		if (Object.keys(statsOut).length) {
			writeFileSync(join(OUT_STATS, `${key}.json`), JSON.stringify(statsOut));
			statsKeys.push(key);
			console.log(`stats/${key}.json: ${Object.keys(statsOut).length} species`);
		}
		if (Object.keys(movesFreqOut).length) {
			writeFileSync(join(OUT_MOVES_FREQ, `${key}.json`), JSON.stringify(movesFreqOut));
			movesFreqKeys.push(key);
			console.log(`moves-freq/${key}.json: ${Object.keys(movesFreqOut).length} species`);
		}
	}
	console.log(`items: ${itemKeys.length} files -> ${itemKeys.join(', ')}`);
	console.log(`abilities: ${abilityKeys.length} files -> ${abilityKeys.join(', ')}`);
	console.log(`tera: ${teraKeys.length} files -> ${teraKeys.join(', ')}`);
	console.log(`stats: ${statsKeys.length} files -> ${statsKeys.join(', ')}`);
	console.log(`moves-freq: ${movesFreqKeys.length} files -> ${movesFreqKeys.join(', ')}`);
}

console.log(`\nBundle written to ${OUT}`);
