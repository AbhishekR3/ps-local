// Generates a comprehensive human-readable battle log from a BattleState and raw frame buffer.
// The output is designed to be pasted directly into an LLM for coaching analysis.
import { parseIdent, parseCondition, parseDetails } from './parser.js';

const STAT_NAMES = { atk: 'Attack', def: 'Defense', spa: 'Sp. Atk', spd: 'Sp. Def', spe: 'Speed', acc: 'Accuracy', eva: 'Evasion' };
const STATUS_NAMES = { brn: 'burned', par: 'paralyzed', psn: 'poisoned', tox: 'badly poisoned', slp: 'asleep', frz: 'frozen', fnt: 'fainted' };
const WEATHER_NAMES = {
	RainDance: 'Rain', PrimordialSea: 'Heavy Rain', SunnyDay: 'Sun', DesolateLand: 'Harsh Sun',
	Sandstorm: 'Sandstorm', Hail: 'Hail', Snow: 'Snow', DeltaStream: 'Strong Winds',
};
const TERRAIN_NAMES = { ElectricTerrain: 'Electric Terrain', GrassyTerrain: 'Grassy Terrain', MistyTerrain: 'Misty Terrain', PsychicTerrain: 'Psychic Terrain' };

const hr = (char = '=', len = 72) => char.repeat(len);

function pct(hp, maxhp) {
	if (!maxhp) return '?%';
	return Math.round(hp / maxhp * 100) + '%';
}

function moveDetail(id, movesData) {
	const m = movesData?.[id];
	if (!m) return id;
	const bp = m.basePower ? ` · ${m.basePower} BP` : '';
	return `${m.name} (${m.type} · ${m.category}${bp})`;
}

function formatBoosts(boostObj) {
	if (!boostObj) return '';
	const parts = [];
	for (const [stat, val] of Object.entries(boostObj)) {
		if (val !== 0) parts.push(`${STAT_NAMES[stat] || stat} ${val > 0 ? '+' : ''}${val}`);
	}
	return parts.join(', ');
}

function fieldLine(state, mySide) {
	const parts = [];
	if (state.weather) parts.push(WEATHER_NAMES[state.weather] || state.weather);
	if (state.terrain) parts.push(TERRAIN_NAMES[state.terrain] || state.terrain);
	const opp = mySide === 'p1' ? 'p2' : 'p1';
	for (const [cond, layers] of Object.entries(state.sideConditions[mySide] || {})) {
		parts.push(`${cond}${layers > 1 ? ` ×${layers}` : ''} [your side]`);
	}
	for (const [cond, layers] of Object.entries(state.sideConditions[opp] || {})) {
		parts.push(`${cond}${layers > 1 ? ` ×${layers}` : ''} [opp side]`);
	}
	for (const cond of Object.keys(state.pseudoWeather)) {
		parts.push(cond);
	}
	return parts.length ? parts.join(' · ') : 'None';
}

// Render one turn's raw protocol lines into a human-readable narrative.
// hpBefore tracks HP% at the start of each event for "before→after" annotations.
function renderTurn(turnNum, lines, mySide, movesData) {
	const oppSide = mySide === 'p1' ? 'p2' : 'p1';
	const out = [];
	// Track HP percentages and owner name per slot for damage annotations.
	const hp = {};        // slot -> { hp, maxhp } updated as we go
	const slotName = {};  // slot -> "Species"
	let lastMoveTarget = null; // slot that was the most recent damage target
	let lastMoveLine = -1;     // index into out[] where the last move line sits

	const slotLabel = (slot) => {
		if (!slot) return '?';
		const side = slot.slice(0, 2) === mySide ? 'You' : 'Opp';
		return `${side}:${slotName[slot] || slot}`;
	};

	for (const line of lines) {
		const parts = line.split('|');
		const cmd = parts[1];

		switch (cmd) {
			case 'switch':
			case 'drag':
			case 'replace': {
				const ident = parseIdent(parts[2]);
				if (!ident) break;
				const det = parseDetails(parts[3] || '');
				const cond = parts[4] ? parseCondition(parts[4]) : { hp: 100, maxhp: 100 };
				slotName[ident.slot] = det.species;
				hp[ident.slot] = { hp: cond.hp, maxhp: cond.maxhp };
				const side = ident.side === mySide ? 'You' : 'Opp';
				const hpStr = `HP: ${pct(cond.hp, cond.maxhp)}`;
				out.push(`  ${side}:${det.species} switched in (L${det.level}${det.gender ? ' ' + det.gender : ''}, ${hpStr})`);
				lastMoveTarget = null;
				break;
			}
			case 'move': {
				const ident = parseIdent(parts[2]);
				const targetIdent = parseIdent(parts[4] || '');
				if (!ident) break;
				const species = slotName[ident.slot] || ident.name;
				const moveName = parts[3];
				const detail = moveDetail(moveName.toLowerCase().replace(/[^a-z0-9]/g, ''), movesData);
				const side = ident.side === mySide ? 'You' : 'Opp';
				const targetStr = targetIdent ? ` → ${slotLabel(targetIdent.slot)}` : '';
				lastMoveTarget = targetIdent?.slot || null;
				lastMoveLine = out.length;
				out.push(`  ${side}:${species} used ${detail}${targetStr}`);
				break;
			}
			case '-damage': {
				const ident = parseIdent(parts[2]);
				if (!ident) break;
				const cond = parseCondition(parts[3] || '100/100');
				const prev = hp[ident.slot] || { hp: cond.maxhp, maxhp: cond.maxhp };
				const before = pct(prev.hp, prev.maxhp || cond.maxhp);
				const after = cond.fainted ? 'fainted' : pct(cond.hp, cond.maxhp);
				hp[ident.slot] = { hp: cond.hp, maxhp: cond.maxhp || prev.maxhp };
				// Append damage inline to the last move line if target matches.
				if (lastMoveLine >= 0 && ident.slot === lastMoveTarget) {
					out[lastMoveLine] += ` [${before} → ${after}]`;
				} else {
					const side = ident.side === mySide ? 'You' : 'Opp';
					out.push(`    ${side}:${slotName[ident.slot] || ident.name} took damage [${before} → ${after}]`);
				}
				break;
			}
			case '-heal':
			case '-sethp': {
				const ident = parseIdent(parts[2]);
				if (!ident) break;
				const cond = parseCondition(parts[3] || '100/100');
				const prev = hp[ident.slot] || { hp: cond.hp, maxhp: cond.maxhp };
				const before = pct(prev.hp, prev.maxhp || cond.maxhp);
				const after = pct(cond.hp, cond.maxhp);
				hp[ident.slot] = { hp: cond.hp, maxhp: cond.maxhp };
				const side = ident.side === mySide ? 'You' : 'Opp';
				const species = slotName[ident.slot] || ident.name;
				const fromTag = parts.find((p) => p.startsWith('[from]'))?.slice(7) || 'healed';
				out.push(`    ${side}:${species} ${fromTag} [${before} → ${after}]`);
				break;
			}
			case '-boost':
			case '-unboost': {
				const ident = parseIdent(parts[2]);
				if (!ident) break;
				const stat = STAT_NAMES[parts[3]] || parts[3];
				const n = parseInt(parts[4], 10) || 1;
				const dir = cmd === '-boost' ? `+${n}` : `-${n}`;
				const side = ident.side === mySide ? 'You' : 'Opp';
				const species = slotName[ident.slot] || ident.name;
				// Append stat change inline to the last move line when it immediately follows a move.
				if (lastMoveLine >= 0 && lastMoveLine === out.length - 1) {
					out[lastMoveLine] += ` [${stat} ${dir}]`;
				} else {
					out.push(`    ${side}:${species} ${stat} ${dir}`);
				}
				break;
			}
			case '-setboost': {
				const ident = parseIdent(parts[2]);
				if (!ident) break;
				const stat = STAT_NAMES[parts[3]] || parts[3];
				const val = parseInt(parts[4], 10);
				const side = ident.side === mySide ? 'You' : 'Opp';
				out.push(`    ${side}:${slotName[ident.slot] || ident.name} ${stat} set to ${val > 0 ? '+' : ''}${val}`);
				break;
			}
			case '-clearboost':
			case '-clearallboost': {
				const ident = parseIdent(parts[2]);
				const label = ident ? `${ident.side === mySide ? 'You' : 'Opp'}:${slotName[ident.slot] || ident.name}` : 'All';
				out.push(`    ${label} stat boosts cleared`);
				break;
			}
			case '-crit':
				if (lastMoveLine >= 0) out[lastMoveLine] += ' (critical hit)';
				break;
			case '-supereffective':
				if (lastMoveLine >= 0) out[lastMoveLine] += ' (super effective)';
				break;
			case '-resisted':
				if (lastMoveLine >= 0) out[lastMoveLine] += ' (not very effective)';
				break;
			case '-immune': {
				const ident = parseIdent(parts[2]);
				if (lastMoveLine >= 0) out[lastMoveLine] += ` (no effect on ${slotName[ident?.slot] || '?'})`;
				break;
			}
			case '-miss': {
				if (lastMoveLine >= 0) out[lastMoveLine] += ' (missed)';
				break;
			}
			case '-status': {
				const ident = parseIdent(parts[2]);
				if (!ident) break;
				const statusName = STATUS_NAMES[parts[3]] || parts[3];
				const side = ident.side === mySide ? 'You' : 'Opp';
				out.push(`    ${side}:${slotName[ident.slot] || ident.name} was ${statusName}`);
				break;
			}
			case '-curestatus': {
				const ident = parseIdent(parts[2]);
				if (!ident) break;
				const side = ident.side === mySide ? 'You' : 'Opp';
				out.push(`    ${side}:${slotName[ident.slot] || ident.name} was cured of its status`);
				break;
			}
			case 'faint': {
				const ident = parseIdent(parts[2]);
				if (!ident) break;
				const side = ident.side === mySide ? 'You' : 'Opp';
				out.push(`  *** ${side}:${slotName[ident.slot] || ident.name} FAINTED ***`);
				break;
			}
			case '-terastallize': {
				const ident = parseIdent(parts[2]);
				if (!ident) break;
				const side = ident.side === mySide ? 'You' : 'Opp';
				out.push(`    ${side}:${slotName[ident.slot] || ident.name} terastallized into ${parts[3]} type`);
				break;
			}
			case '-ability': {
				const ident = parseIdent(parts[2]);
				if (!ident) break;
				const side = ident.side === mySide ? 'You' : 'Opp';
				out.push(`    ${side}:${slotName[ident.slot] || ident.name} ability revealed: ${parts[3]}`);
				break;
			}
			case '-item': {
				const ident = parseIdent(parts[2]);
				if (!ident) break;
				const side = ident.side === mySide ? 'You' : 'Opp';
				out.push(`    ${side}:${slotName[ident.slot] || ident.name} item revealed: ${parts[3]}`);
				break;
			}
			case '-enditem': {
				const ident = parseIdent(parts[2]);
				if (!ident) break;
				const side = ident.side === mySide ? 'You' : 'Opp';
				out.push(`    ${side}:${slotName[ident.slot] || ident.name} lost item: ${parts[3]}`);
				break;
			}
			case '-weather': {
				const w = parts[2];
				if (w === 'none' || !w) {
					out.push(`    Weather ended`);
				} else {
					out.push(`    ${WEATHER_NAMES[w] || w} started`);
				}
				break;
			}
			case '-terrain': {
				const t = parts[2];
				if (t === 'none' || !t) {
					out.push(`    Terrain faded`);
				} else {
					out.push(`    ${TERRAIN_NAMES[t] || t} spread`);
				}
				break;
			}
			case '-fieldstart': {
				const effect = parts[2]?.replace(/^move: /, '');
				if (effect) out.push(`    Field effect: ${effect} started`);
				break;
			}
			case '-fieldend': {
				const effect = parts[2]?.replace(/^move: /, '');
				if (effect) out.push(`    Field effect: ${effect} ended`);
				break;
			}
			case '-sidestart': {
				const side = parts[2]?.replace(/:.*/, '');
				const cond = parts[3]?.replace(/^move: /, '');
				if (side && cond) {
					const label = side === mySide ? 'Your side' : "Opponent's side";
					out.push(`    ${label}: ${cond} set up`);
				}
				break;
			}
			case '-sideend': {
				const side = parts[2]?.replace(/:.*/, '');
				const cond = parts[3]?.replace(/^move: /, '');
				if (side && cond) {
					const label = side === mySide ? 'Your side' : "Opponent's side";
					out.push(`    ${label}: ${cond} ended`);
				}
				break;
			}
			case '-start': {
				const ident = parseIdent(parts[2]);
				const effect = parts[3]?.replace(/^move: /, '');
				if (ident && effect) {
					const side = ident.side === mySide ? 'You' : 'Opp';
					out.push(`    ${side}:${slotName[ident.slot] || ident.name} ${effect} started`);
				}
				break;
			}
			case '-end': {
				const ident = parseIdent(parts[2]);
				const effect = parts[3]?.replace(/^move: /, '');
				if (ident && effect) {
					const side = ident.side === mySide ? 'You' : 'Opp';
					out.push(`    ${side}:${slotName[ident.slot] || ident.name} ${effect} ended`);
				}
				break;
			}
			case '-activate': {
				const ident = parseIdent(parts[2]);
				const effect = parts[3]?.replace(/^(move|ability|item): /, '');
				if (ident && effect) {
					const side = ident.side === mySide ? 'You' : 'Opp';
					out.push(`    ${side}:${slotName[ident.slot] || ident.name} activated: ${effect}`);
				}
				break;
			}
			// Lines that are informational but don't need annotation — emit as raw.
			case '-fail':
			case '-block':
			case '-notarget':
			case '-ohko':
			case '-hitcount':
			case 'cant':
			case 'upkeep':
			case '-singleturn':
			case '-singlemove':
			case '-prepare':
			case '-zpower':
			case '-burst':
			case '-mega':
			case '-primal':
				// Omit noise — these rarely affect strategy analysis.
				break;
			// Explicit skip for frame-routing lines.
			case 'upkeep':
			case 'request':
			case 'win':
			case 'tie':
			case 'turn':
			case 'player':
			case 'gen':
			case 'gametype':
			case 'tier':
			case 'clearpoke':
			case 'poke':
			case 'teampreview':
			case 'start':
			case 'rule':
			case 't:':
			case 'inactive':
			case 'inactiveoff':
			case 'seed':
			case '':
				break;
			default:
				// Keep unrecognised lines verbatim so nothing is silently dropped.
				if (line.trim()) out.push(`    ${line.trim()}`);
		}
	}
	return out;
}

export function generateBattleLog(state, rawFrames, movesData) {
	const mySide = state.mySide || 'p1';
	const oppSide = mySide === 'p1' ? 'p2' : 'p1';
	const myName = state.players[mySide]?.name || mySide;
	const oppName = state.players[oppSide]?.name || oppSide;

	// Determine result string.
	let result;
	if (!state.ended) {
		result = 'IN PROGRESS';
	} else if (!state.winner) {
		result = 'TIE';
	} else if (state.winner === myName) {
		result = 'YOU WON';
	} else {
		result = 'YOU LOST';
	}

	const lines = [];

	// ── BATTLE SUMMARY ────────────────────────────────────────────────────────
	lines.push(hr());
	lines.push('POKEMON SHOWDOWN BATTLE LOG');
	lines.push(hr());
	lines.push(`Format:    ${state.tier || state.formatId || 'Unknown'}`);
	lines.push(`Gen:       ${state.gen ?? '?'}`);
	lines.push(`Game type: ${state.gameType || 'singles'}`);
	lines.push(`Players:   ${myName} (you) vs ${oppName} (opponent)`);
	lines.push(`Turns:     ${state.turn}`);
	lines.push(`Result:    ${result}`);
	lines.push(`Generated: ${new Date().toLocaleString()}`);
	lines.push('');

	// ── YOUR TEAM ─────────────────────────────────────────────────────────────
	lines.push(hr());
	lines.push('YOUR TEAM  (full details from request data)');
	lines.push(hr());
	if (state.myTeam.length === 0) {
		lines.push('  (no team data — |request| not yet received)');
	} else {
		for (const p of state.myTeam) {
			const gender = p.gender ? ` ${p.gender}` : '';
			const cond = p.condition || '100/100';
			const hpStr = (() => {
				const parts = cond.split('/');
				if (parts.length === 2) return pct(Number(parts[0]), Number(parts[1]));
				return cond;
			})();
			lines.push(`  ${p.species}  L${p.level}${gender}  |  HP: ${hpStr}  |  Item: ${p.item || '?'}  |  Ability: ${p.ability || '?'}  |  Tera: ${p.teraType || '?'}`);
			if (p.stats) {
				const st = p.stats;
				lines.push(`    Stats: HP ${p.condition?.split('/')[1] || '?'} / Atk ${st.atk} / Def ${st.def} / SpA ${st.spa} / SpD ${st.spd} / Spe ${st.spe}`);
			}
			if (p.moves?.length) {
				const moveStr = p.moves.map((id) => moveDetail(id, movesData)).join('  |  ');
				lines.push(`    Moves: ${moveStr}`);
			}
		}
	}
	lines.push('');

	// ── OPPONENT TEAM (REVEALED) ───────────────────────────────────────────────
	lines.push(hr());
	lines.push(`OPPONENT TEAM  (${oppName} — revealed during battle)`);
	lines.push(hr());
	const oppRevealed = Object.values(state.revealed[oppSide] || {});
	if (oppRevealed.length === 0) {
		lines.push('  (nothing revealed yet)');
	} else {
		for (const r of oppRevealed) {
			const levelStr = r.level ? ` L${r.level}` : '';
			const itemStr = r.item ? `  |  Item: ${r.item}` : '  |  Item: ?';
			const abilStr = r.ability ? `  |  Ability: ${r.ability}` : '  |  Ability: ?';
			const faintStr = r.fainted ? '  |  FAINTED' : '';
			lines.push(`  ${r.species}${levelStr}${itemStr}${abilStr}${faintStr}`);
			if (r.moves.size > 0) {
				const moveStr = [...r.moves].map((id) => moveDetail(id, movesData)).join('  |  ');
				lines.push(`    Moves seen: ${moveStr}`);
			}
		}
	}
	lines.push('');

	// ── FIELD STATE AT END ────────────────────────────────────────────────────
	lines.push(hr());
	lines.push('FIELD STATE AT END OF BATTLE');
	lines.push(hr());
	lines.push(`Weather:      ${state.weather ? (WEATHER_NAMES[state.weather] || state.weather) : 'None'}`);
	lines.push(`Terrain:      ${state.terrain ? (TERRAIN_NAMES[state.terrain] || state.terrain) : 'None'}`);
	const pwKeys = Object.keys(state.pseudoWeather);
	lines.push(`Field effects: ${pwKeys.length ? pwKeys.join(', ') : 'None'}`);
	lines.push(`Your side (${myName}): ${Object.keys(state.sideConditions[mySide] || {}).map((k) => `${k}${state.sideConditions[mySide][k] > 1 ? ' ×' + state.sideConditions[mySide][k] : ''}`).join(', ') || 'None'}`);
	lines.push(`Opp side (${oppName}): ${Object.keys(state.sideConditions[oppSide] || {}).map((k) => `${k}${state.sideConditions[oppSide][k] > 1 ? ' ×' + state.sideConditions[oppSide][k] : ''}`).join(', ') || 'None'}`);
	// Active boosts at end of battle
	const boostEntries = Object.entries(state.boosts).filter(([, b]) => Object.values(b).some((v) => v !== 0));
	if (boostEntries.length) {
		lines.push('Active stat boosts:');
		for (const [slot, b] of boostEntries) {
			lines.push(`  ${slot}: ${formatBoosts(b)}`);
		}
	}
	lines.push('');

	// ── TURN-BY-TURN LOG ──────────────────────────────────────────────────────
	lines.push(hr());
	lines.push('TURN-BY-TURN BATTLE LOG');
	lines.push(hr());

	if (state.turnLog.length === 0) {
		// Fall back to annotating raw frames when the parser didn't accumulate a turnLog
		// (e.g. an older buffer replayed without the updated parser).
		lines.push('  (turn log not available — showing raw protocol frames)');
		lines.push('');
		for (const frame of rawFrames) {
			lines.push(frame);
		}
	} else {
		// Replay all frames to rebuild HP state at start of each turn for context.
		// We walk the turnLog using the same annotation logic as renderTurn.
		const allSlotNames = {}; // accumulated across turns
		const allHp = {};        // accumulated hp across turns
		for (const turn of state.turnLog) {
			lines.push('');
			lines.push(`--- TURN ${turn.num} ---`);
			// Show active boosts at turn start for any slot with non-zero boosts.
			const turnBoostEntries = Object.entries(state.boosts).filter(([, b]) => Object.values(b).some((v) => v !== 0));
			if (turnBoostEntries.length) {
				const boostSummary = turnBoostEntries
					.map(([slot, b]) => `${allSlotNames[slot] || slot}: ${formatBoosts(b)}`)
					.join(', ');
				lines.push(`  Active boosts: ${boostSummary}`);
			}
			// Render the turn's events.
			const rendered = renderTurn(turn.num, turn.lines, mySide, movesData);
			// Propagate slot names gathered during render (needed if this turn had switches).
			lines.push(...rendered);
		}
	}
	lines.push('');

	// ── RAW PROTOCOL (appendix) ────────────────────────────────────────────────
	lines.push(hr());
	lines.push('RAW PROTOCOL  (complete reference — all WebSocket frames)');
	lines.push(hr());
	for (const frame of rawFrames) {
		lines.push(frame);
	}
	lines.push('');

	// ── ANALYSIS PROMPT ────────────────────────────────────────────────────────
	lines.push(hr('='));
	lines.push('LLM ANALYSIS PROMPT');
	lines.push('Copy everything from the top of this file through this section and paste it');
	lines.push('into your LLM of choice. The prompt below instructs the LLM on what to analyze.');
	lines.push(hr('-'));
	lines.push('');
	lines.push('The content above is a complete Pokemon Showdown battle log.');
	lines.push(`It was played by ${myName} (labeled "You" throughout) against ${oppName} (labeled "Opp").`);
	lines.push(`Format: ${state.tier || state.formatId || 'Unknown'}  |  Result: ${result}  |  Turns: ${state.turn}`);
	lines.push('');
	lines.push('Please provide a thorough coaching analysis of this battle. For every claim you');
	lines.push('make, you MUST cite the specific turn number, the move used, and the HP values');
	lines.push('or stat changes from the log that prove your point. Vague observations without');
	lines.push('evidence are not useful — ground every statement in the data above.');
	lines.push('');
	lines.push('Cover the following, in order:');
	lines.push('');
	lines.push('1. OUTCOME DRIVERS');
	lines.push('   What specific decisions, sequences, or events most determined the final result?');
	lines.push('   Cite the exact turn(s), HP values, and moves involved.');
	lines.push('');
	lines.push('2. KEY MISPLAYS (both sides)');
	lines.push('   For each misplay: name the turn, what happened, what a better option was,');
	lines.push('   and why the alternative was stronger given the game state at that moment.');
	lines.push('   Consider move choice, switch timing, Tera activation, and target selection.');
	lines.push('');
	lines.push('3. MISSED WINNING LINES');
	lines.push('   Were there moments where a clean winning sequence existed but wasn\'t taken?');
	lines.push('   Walk through the line: turn X do A, then turn X+1 do B, etc.');
	lines.push('');
	lines.push('4. OPPONENT ANALYSIS');
	lines.push('   What was the opponent\'s win condition? Which of their plays were well-executed?');
	lines.push('   What threats did they set up and how did they try to exploit them?');
	lines.push('');
	lines.push('5. RESOURCE MANAGEMENT');
	lines.push('   Evaluate how both sides used: stat boosts (cite the turns), entry hazards,');
	lines.push('   weather/terrain, items, and status moves. Was anything wasted or under-utilized?');
	lines.push('');
	lines.push('6. TEAM SYNERGY & COVERAGE');
	lines.push('   Did the team\'s moves, abilities, and items work together as a unit?');
	lines.push('   Were there type matchups or win conditions that went unused? What would have');
	lines.push('   been the optimal sequencing of the team given the opponent\'s revealed team?');
	lines.push('');
	lines.push('7. CONCRETE IMPROVEMENTS (3-5 items)');
	lines.push('   Specific, actionable things the player should do differently next time,');
	lines.push('   each tied to at least one concrete moment from this game as evidence.');
	lines.push('');
	lines.push('Be as detailed as the data supports. The goal is deep, honest coaching —');
	lines.push('not encouragement. Every strength must be earned by the data; every weakness');
	lines.push('must be proven by a turn reference.');
	lines.push(hr('='));

	return lines.join('\n');
}
