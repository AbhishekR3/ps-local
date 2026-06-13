// Lookup engine: turn a species id + battle format into a full breakdown the UI renders.
//
// Pure functions only — the caller supplies already-loaded data (pokedex, moves, the
// resolved sets file). This keeps the module usable identically in Node tests and the
// browser panel.
import { toID } from './toid.js';

/**
 * @typedef {Object} MoveInfo
 * @property {string} id
 * @property {string} name
 * @property {string} type
 * @property {string} category
 * @property {number} basePower
 * @property {number|true} accuracy
 * @property {number} pp
 */

/**
 * Map a battle format id to the sets-file key produced by build-data.js.
 * Returns null for non-random formats (we only ship random-battle data).
 *   gen9randombattle        -> "gen9"
 *   gen9randomdoublesbattle -> "gen9doubles"
 * @param {string} formatId
 * @returns {string|null}
 */
export function resolveSetsKey(formatId) {
	const id = toID(formatId);
	if (!id.includes('random')) return null;
	const gen = id.match(/^gen(\d+)/);
	if (!gen) return null;
	const n = gen[1];
	return id.includes('doubles') ? `gen${n}doubles` : `gen${n}`;
}

// gen1's data.json uses {level, moves[], essentialMoves?, comboMoves?} instead of
// the {level, sets:[{role, movepool, abilities, teraTypes}]} shape. Normalize it.
function normalizeEntry(entry) {
	if (!entry) return null;
	if (entry.sets) return entry;
	const movepool = [...new Set([
		...(entry.moves || []),
		...(entry.essentialMoves || []),
		...(entry.comboMoves || []),
	])];
	return {
		level: entry.level,
		sets: [{ role: 'Random Set', movepool, abilities: [], teraTypes: [] }],
	};
}

function resolveMove(name, moves) {
	const id = toID(name);
	const m = moves[id];
	if (!m) return { id, name, type: '???', category: 'Status', basePower: 0, accuracy: true, pp: 0 };
	return { id, name: m.name, type: m.type, category: m.category, basePower: m.basePower, accuracy: m.accuracy, pp: m.pp };
}

// Merge sets with identical movepools into one, combining abilities and tera types.
// Stores the original role names in _roles so Monte Carlo lookups still work.
function deduplicateSets(sets) {
	const seen = new Map();
	for (const s of sets) {
		const key = s.moves.map((m) => m.id).sort().join('\0');
		if (seen.has(key)) {
			const g = seen.get(key);
			g._roles.push(s.role);
			g.role += ' / ' + s.role;
			for (const a of s.abilities) if (!g.abilities.includes(a)) g.abilities.push(a);
			for (const t of s.teraTypes) if (!g.teraTypes.includes(t)) g.teraTypes.push(t);
		} else {
			seen.set(key, { ...s, _roles: [s.role], abilities: [...s.abilities], teraTypes: [...s.teraTypes] });
		}
	}
	return [...seen.values()];
}

// Aggregate move-frequency data for a (possibly merged) set across its original roles.
// Returns { total, moves: { moveId: count } } or null if no data.
function moveFreqForSet(movesFreqData, speciesId, set) {
	const byRole = movesFreqData?.[speciesId];
	if (!byRole) return null;
	let combinedTotal = 0;
	const combinedMoves = {};
	for (const role of (set._roles || [set.role])) {
		const rd = byRole[role];
		if (!rd) continue;
		combinedTotal += rd.total || 0;
		for (const [mid, cnt] of Object.entries(rd.moves || {})) {
			combinedMoves[mid] = (combinedMoves[mid] || 0) + cnt;
		}
	}
	return combinedTotal ? { total: combinedTotal, moves: combinedMoves } : null;
}

// Helper: tally counts across the original role names of the relevant (possibly merged) sets.
function tallyByRole(byRole, relevantSets) {
	const totals = {};
	let grand = 0;
	// Use _roles (original names pre-merge) so data file keys still match.
	for (const s of relevantSets) {
		for (const role of (s._roles || [s.role])) {
			const counts = byRole[role];
			if (!counts) continue;
			for (const [key, count] of Object.entries(counts)) {
				totals[key] = (totals[key] || 0) + count;
				grand += count;
			}
		}
	}
	return { totals, grand };
}

// Assign integer percentages summing to exactly 100 across the WHOLE distribution using the
// largest-remainder (Hamilton) method — independent Math.round() per entry can otherwise make a set
// total 99 or 101. `sortedEntries` is [key, count][] pre-sorted by count desc (that order also breaks
// remainder ties toward the higher count). Returns the same order with an integer `pct`. Slicing the
// result to a top-N afterward stays faithful: the prefix sums to <=100 and never exceeds 100.
function largestRemainderPct(sortedEntries, grand) {
	const rows = sortedEntries.map(([key, count]) => {
		const exact = (count / grand) * 100;
		const floor = Math.floor(exact);
		return { key, count, pct: floor, rem: exact - floor };
	});
	let leftover = 100 - rows.reduce((s, r) => s + r.pct, 0);
	// Hand the leftover whole points to the largest remainders (ties -> higher count).
	for (const r of [...rows].sort((a, b) => (b.rem - a.rem) || (b.count - a.count))) {
		if (leftover <= 0) break;
		r.pct += 1;
		leftover -= 1;
	}
	return rows;
}

// Resolve the count distribution for a species across the still-relevant sets, falling back to all
// roles when the relevant ones carry no data. Returns the sorted [key, count][] and the grand total.
function distributionFor(byRole, relevantSets) {
	let { totals, grand } = tallyByRole(byRole, relevantSets);
	if (!grand) {
		// Fallback: tally all roles as synthetic single-role sets.
		const allRoleSets = Object.keys(byRole).map((r) => ({ role: r, _roles: [r] }));
		({ totals, grand } = tallyByRole(byRole, allRoleSets));
	}
	return { sorted: Object.entries(totals).sort((a, b) => b[1] - a[1]), grand };
}

// Top-3 likely items for a species, summed over the roles of the still-relevant sets so the
// prediction sharpens as revealed moves narrow the set. itemsData shape: see build-data.js.
function predictItems(itemsData, id, relevantSets) {
	const byRole = itemsData?.[id];
	if (!byRole) return [];
	const { sorted, grand } = distributionFor(byRole, relevantSets);
	if (!grand) return [];
	return largestRemainderPct(sorted, grand).slice(0, 3).map((r) => ({ item: r.key, pct: r.pct }));
}

// Top-5 likely tera types, weighted by Monte Carlo frequency across relevant sets.
function predictTeras(teraData, id, relevantSets) {
	const byRole = teraData?.[id];
	if (!byRole) return [];
	const { sorted, grand } = distributionFor(byRole, relevantSets);
	if (!grand) return [];
	return largestRemainderPct(sorted, grand).slice(0, 5).map((r) => ({ teraType: r.key, pct: r.pct }));
}

// Top-3 likely abilities for a species, weighted by Monte Carlo frequency across relevant sets.
function predictAbilities(abilitiesData, id, relevantSets) {
	const byRole = abilitiesData?.[id];
	if (!byRole) return [];
	const { sorted, grand } = distributionFor(byRole, relevantSets);
	if (!grand) return [];
	return largestRemainderPct(sorted, grand).slice(0, 3).map((r) => ({ ability: r.key, pct: r.pct }));
}

/**
 * Build the full breakdown for one Pokemon.
 * @param {string} species  raw species name or id
 * @param {{pokedex:Object, moves:Object, sets:Object, items?:Object, abilities?:Object, teras?:Object, movesFreq?:Object}} data
 * @param {Set<string>|string[]|null} revealedMoves  move ids the opponent has used (narrows sets)
 * @returns {Object} breakdown (always returns dex info even if no set data exists)
 */
export function getBreakdown(species, data, revealedMoves = null) {
	const id = toID(species);
	const dex = data.pokedex[id] || null;
	// Cosmetic/alternate formes (Maushold-Four, Tatsugiri-Stretchy, …) ship no random-battle data under
	// their own id. When that happens, fall back to the base species' id (from the dex `baseSpecies`
	// field) for every set-derived lookup — sets, items, abilities, teras, movesFreq, and the MC stats
	// (which render.ts keys off the returned `id`). `id` itself still names the forme for display.
	let dataId = id;
	let entry = normalizeEntry(data.sets ? data.sets[id] : null);
	if (!entry && dex?.baseSpecies) {
		const baseId = toID(dex.baseSpecies);
		const baseEntry = normalizeEntry(data.sets ? data.sets[baseId] : null);
		if (baseEntry) { dataId = baseId; entry = baseEntry; }
	}
	const revealed = revealedMoves instanceof Set ? revealedMoves : new Set(revealedMoves || []);
	const revealedCount = revealed.size;

	const rawSets = [];
	if (entry) {
		for (const s of entry.sets) {
			const moves = (s.movepool || []).map((m) => {
				const mv = resolveMove(m, data.moves);
				mv.used = revealed.has(mv.id); // for the UI to highlight already-seen moves
				return mv;
			});
			const poolIds = new Set(moves.map((m) => m.id));
			let matchCount = 0;
			for (const r of revealed) if (poolIds.has(r)) matchCount++;
			rawSets.push({
				role: s.role,
				moves,
				abilities: s.abilities || [],
				teraTypes: s.teraTypes || [],
				matchCount,
				// A set is still possible only if EVERY revealed move is in its movepool.
				possible: matchCount === revealedCount,
			});
		}
	}
	// Merge sets with identical movepools (same moves but different role names) into one entry,
	// unioning their abilities and tera types. Keeps _roles for Monte Carlo data lookups.
	const sets = deduplicateSets(rawSets);

	// Annotate each set with move frequencies and role frequency from Monte Carlo data.
	// roleFreq: % of samples where this species was assigned this role (or merged roles).
	// mv.freq: % of times this role rolled this move in its 4-move selection.
	if (data.movesFreq?.[dataId]) {
		const allRoleData = data.movesFreq[dataId];
		const speciesTotal = Object.values(allRoleData).reduce((s, r) => s + (r.total || 0), 0);
		for (const set of sets) {
			const mfd = moveFreqForSet(data.movesFreq, dataId, set);
			if (mfd && speciesTotal) {
				set.roleFreq = Math.round(mfd.total / speciesTotal * 100);
				for (const mv of set.moves) {
					mv.freq = Math.round(((mfd.moves[mv.id] || 0) / mfd.total) * 100);
				}
			}
		}
	}

	// Narrow to sets consistent with the revealed moves; never collapse to nothing — if the
	// reveals fit no set (incomplete movepool data), keep all sets and flag low confidence.
	const possibleSets = revealedCount ? sets.filter((s) => s.possible) : sets;
	const relevant = possibleSets.length ? possibleSets : sets;
	const lowConfidence = revealedCount > 0 && possibleSets.length === 0;
	const confirmed = revealedCount >= 4 && possibleSets.length === 1;

	// Abilities / tera narrowed to the relevant sets, falling back to the dex listing.
	const setAbilities = new Set();
	const setTeras = new Set();
	for (const s of relevant) {
		s.abilities.forEach((a) => setAbilities.add(a));
		s.teraTypes.forEach((t) => setTeras.add(t));
	}
	const dexAbilities = dex ? Object.values(dex.abilities) : [];

	return {
		id: dataId,
		name: dex ? dex.name : species,
		num: dex ? dex.num : 0,
		types: dex ? dex.types : [],
		baseStats: dex ? dex.baseStats : null,
		level: entry ? entry.level : null,
		abilities: setAbilities.size ? [...setAbilities] : dexAbilities,
		teraTypes: [...setTeras],
		sets,
		relevantSets: relevant,
		possibleCount: possibleSets.length,
		revealedCount,
		lowConfidence,
		confirmed,
		predictedItems: predictItems(data.items, dataId, relevant),
		predictedAbilities: predictAbilities(data.abilities, dataId, relevant),
		predictedTeras: predictTeras(data.teras, dataId, relevant),
		found: !!entry,
	};
}
