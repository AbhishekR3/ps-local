/* eslint-disable security/detect-object-injection, security/detect-non-literal-fs-filename */
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
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
// ps-local: helper/ is a sibling of vendor/, so the server submodule is ../vendor/pokemon-showdown
const REPO = join(HERE, '..', 'vendor', 'pokemon-showdown');
const OUT = join(HERE, 'extension', 'data');
const OUT_SETS = join(OUT, 'sets');
// Monte-Carlo tables are built in a staging dir and swapped in only once the whole pass succeeds,
// so a failed/partial run never leaves a mix of old and new files, and stale formats never linger.
const STAGE = join(OUT, '.stage');
const OUT_ITEMS = join(STAGE, 'items');
const OUT_ABILITIES = join(STAGE, 'abilities');
const OUT_TERAS = join(STAGE, 'tera');
const OUT_MOVES_FREQ = join(STAGE, 'moves-freq');
const OUT_STATS = join(STAGE, 'stats');
const OUT_JOINT = join(STAGE, 'joint');
const MC_DIRS = ['items', 'abilities', 'tera', 'moves-freq', 'stats', 'joint'];

rmSync(STAGE, { recursive: true, force: true });
rmSync(OUT_SETS, { recursive: true, force: true }); // rewritten in full just below
mkdirSync(OUT_SETS, { recursive: true });
for (const d of [OUT_ITEMS, OUT_ABILITIES, OUT_TERAS, OUT_MOVES_FREQ, OUT_STATS, OUT_JOINT]) mkdirSync(d, { recursive: true });

// --- Pokedex: keep only what the breakdown UI needs ---------------------------
// eslint-disable-next-line no-unsanitized/method -- Node build script; no DOM
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
// eslint-disable-next-line no-unsanitized/method -- Node build script; no DOM
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

// --- Stat distributions: nature multiplier used by the MC loop below -----------
const NATURE_PLUS  = { adamant:'atk', modest:'spa', jolly:'spe', timid:'spe', brave:'atk', quiet:'spa', hasty:'spe', naive:'spe', lonely:'atk', mild:'spa', naughty:'atk', rash:'spa', bold:'def', impish:'def', lax:'def', relaxed:'def', calm:'spd', careful:'spd', gentle:'spd', sassy:'spd' };
const NATURE_MINUS = { adamant:'spa', modest:'atk', jolly:'spa', timid:'atk', brave:'spe', quiet:'spe', hasty:'def', naive:'spd', lonely:'def', mild:'def', naughty:'spd', rash:'spd', bold:'atk', impish:'spa', lax:'spd', relaxed:'spe', calm:'atk', careful:'spa', gentle:'def', sassy:'spe' };
function natureMultiplier(nature, stat) {
	const n = (nature || '').toLowerCase();
	if (NATURE_PLUS[n] === stat) return 1.1;
	if (NATURE_MINUS[n] === stat) return 0.9;
	return 1.0;
}

// --- Predicted items + abilities + tera + moves: Monte-Carlo the real team generator ---------
// Random-battle items, abilities, tera types and the 4-move selection aren't stored statically —
// they're chosen at generation time (and depend on each other: tera is rolled first, then moves
// are chosen with it in mind, then ability and item given moves/tera). We run the actual generator
// many times per species and tally what it picks, keyed by role so predictions sharpen once
// revealed moves narrow the set (lookup.js). For gen9 we also keep the *joint* distribution so that
// any revealed fact (move/item/ability/tera) can eliminate and reweight all the others.
const ROUNDS = Number(process.env.PS_ROUNDS) || 20000;
// Joint tables are only worth shipping where tera exists; override with PS_JOINT_KEYS=a,b.
const JOINT_KEYS = new Set((process.env.PS_JOINT_KEYS || 'gen9,gen9doubles').split(',').filter(Boolean));
// Joint combos seen fewer than this many times are folded into a per-role `other` count so the
// file stays small; probabilities renormalize over the kept mass.
const JOINT_MIN = Number(process.env.PS_JOINT_MIN) || 1;
// Optional: restrict the pass to some keys (quick tests). Without it every key is processed and the
// MC tables are swapped in wholesale; with it only those keys are replaced.
const ONLY = process.env.PS_ONLY ? new Set(process.env.PS_ONLY.split(',')) : null;

// "gen9" -> singles, "gen9doubles" -> doubles. Returns null for non-standard keys.
function keyToFormat(key) {
	const m = key.match(/^gen(\d+)(doubles)?$/);
	if (!m) return null;
	const gen = Number(m[1]);
	const isDoubles = !!m[2];
	return { gen, isDoubles, format: `gen${gen}random${isDoubles ? 'doubles' : ''}battle` };
}

const toMoveId = (mv) => String(mv).toLowerCase().replace(/[^a-z0-9]/g, '');

// Encode one species' joint tallies: { dict: string[], roles: { role: { total, other, rows } } }.
// rows are [itemIdx, abilityIdx, teraIdx(-1 = none), count, ...moveIdx] with moves sorted by id.
function encodeJoint(roleTallies) {
	const dict = [];
	const index = new Map();
	const ix = (s) => {
		let i = index.get(s);
		if (i === undefined) { i = dict.length; dict.push(s); index.set(s, i); }
		return i;
	};
	const roles = {};
	for (const [role, { total, combos }] of Object.entries(roleTallies)) {
		const rows = [];
		let other = 0;
		for (const c of combos.values()) {
			if (c.count < JOINT_MIN) { other += c.count; continue; }
			rows.push([ix(c.item), ix(c.ability), c.tera == null ? -1 : ix(c.tera), c.count, ...c.moves.map(ix)]);
		}
		rows.sort((a, b) => b[3] - a[3]);
		roles[role] = { total, other, rows };
	}
	return { dict, roles };
}

// eslint-disable-next-line no-unsanitized/method -- Node build script; no DOM
const teamsMod = await import(join(REPO, 'dist', 'sim', 'teams.js'));
const Teams = teamsMod.Teams || teamsMod.default?.Teams;
if (!Teams?.getGenerator) {
	console.warn('items/abilities: dist/sim/teams not found — run `npm run build` first. Skipping tables (existing ones kept).');
	rmSync(STAGE, { recursive: true, force: true });
} else {
	const written = Object.fromEntries(MC_DIRS.map((d) => [d, []]));
	const started = Date.now();
	for (const key of available) {
		if (ONLY && !ONLY.has(key)) continue;
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
		const wantJoint = JOINT_KEYS.has(key);
		const itemOut = {};
		const abilityOut = {};
		const teraOut = {};
		const movesFreqOut = {};
		const statsOut = {};
		const jointOut = {};
		for (const id of speciesIds) {
			const itemRoles = {};
			const abilityRoles = {};
			const teraRoles = {};
			let sawItem = false;
			let sawAbility = false;
			let sawTera = false;
			// { role: { total: N, moves: { moveId: count } } }
			const moveFreqRoles = {};
			// { role: { total, combos: Map<key, {item, ability, tera, moves, count}> } }
			const jointRoles = {};
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
				const moveIds = (set.moves || []).map(toMoveId);
				if (!moveFreqRoles[role]) moveFreqRoles[role] = { total: 0, moves: {} };
				moveFreqRoles[role].total++;
				for (const mid of moveIds) {
					moveFreqRoles[role].moves[mid] = (moveFreqRoles[role].moves[mid] || 0) + 1;
				}
				if (wantJoint) {
					const jr = jointRoles[role] || (jointRoles[role] = { total: 0, combos: new Map() });
					jr.total++;
					const sorted = [...moveIds].sort();
					const ck = `${item}|${ability}|${set.teraType || ''}|${sorted.join(',')}`;
					const hit = jr.combos.get(ck);
					if (hit) hit.count++;
					else jr.combos.set(ck, { item, ability, tera: set.teraType || null, moves: sorted, count: 1 });
				}
				// Track per-stat min/max across all MC iterations (no HP — it's revealed in battle).
				const maxIv = meta.gen < 3 ? 30 : 31;
				for (const stat of ['atk', 'def', 'spa', 'spd', 'spe']) {
					const base = pokedex[id]?.baseStats?.[stat];
					if (base == null) continue;
					const iv = Math.min(set.ivs?.[stat] ?? maxIv, maxIv);
					const ev = set.evs?.[stat] ?? 0;
					const lvl = set.level ?? 100;
					const mult = natureMultiplier(set.nature, stat);
					const val = Math.trunc(Math.trunc((2 * base + iv + Math.trunc(ev / 4)) * lvl / 100 + 5) * mult);
					const cur = statsOut[id]?.[stat];
					if (!cur) (statsOut[id] = statsOut[id] || {})[stat] = { min: val, max: val };
					else { cur.min = Math.min(cur.min, val); cur.max = Math.max(cur.max, val); }
				}
			}
			if (sawItem) itemOut[id] = itemRoles;
			if (sawAbility) abilityOut[id] = abilityRoles;
			if (sawTera) teraOut[id] = teraRoles;
			if (Object.keys(moveFreqRoles).length) movesFreqOut[id] = moveFreqRoles;
			if (wantJoint && Object.keys(jointRoles).length) jointOut[id] = encodeJoint(jointRoles);
		}
		const emit = (dir, outDir, data, label) => {
			if (!Object.keys(data).length) return;
			writeFileSync(join(outDir, `${key}.json`), JSON.stringify(data));
			written[dir].push(key);
			console.log(`${label}/${key}.json: ${Object.keys(data).length} species`);
		};
		emit('items', OUT_ITEMS, itemOut, 'items');
		emit('abilities', OUT_ABILITIES, abilityOut, 'abilities');
		emit('tera', OUT_TERAS, teraOut, 'tera');
		emit('moves-freq', OUT_MOVES_FREQ, movesFreqOut, 'moves-freq');
		emit('stats', OUT_STATS, statsOut, 'stats');
		emit('joint', OUT_JOINT, jointOut, 'joint');
		console.log(`  [${((Date.now() - started) / 60000).toFixed(1)} min] ${key} done`);
	}

	// Swap the staged tables in. A full run replaces each dir wholesale (drops stale files); a
	// PS_ONLY run only replaces the files it produced.
	for (const d of MC_DIRS) {
		const live = join(OUT, d);
		const staged = join(STAGE, d);
		if (!ONLY) {
			rmSync(live, { recursive: true, force: true });
			renameSync(staged, live);
		} else {
			mkdirSync(live, { recursive: true });
			for (const key of written[d]) renameSync(join(staged, `${key}.json`), join(live, `${key}.json`));
		}
		console.log(`${d}: ${written[d].length} files -> ${written[d].join(', ')}`);
	}
	rmSync(STAGE, { recursive: true, force: true });
}
