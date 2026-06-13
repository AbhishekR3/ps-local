import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BattleTracker } from '../extension/lib/parser.js';
import { generateBattleLog } from '../extension/lib/exporter.js';

// Minimal moves data for testing move detail annotation.
const MOVES = {
	earthquake: { name: 'Earthquake', type: 'Ground', category: 'Physical', basePower: 100 },
	thunderbolt: { name: 'Thunderbolt', type: 'Electric', category: 'Special', basePower: 90 },
	dragondance: { name: 'Dragon Dance', type: 'Dragon', category: 'Status', basePower: 0 },
	flamethrower: { name: 'Flamethrower', type: 'Fire', category: 'Special', basePower: 90 },
	stealthrock: { name: 'Stealth Rock', type: 'Rock', category: 'Status', basePower: 0 },
};

const BATTLE_FRAMES = [
	'>battle-gen9randombattle-99',
	'|init|battle',
	'|gen|9',
	'|gametype|singles',
	'|tier|[Gen 9] Random Battle',
	'|player|p1|Ash|1|',
	'|player|p2|Gary|2|',
	'|switch|p1a: Pikachu|Pikachu, L88, M|100/100',
	'|switch|p2a: Swampert|Swampert, L82, M|100/100',
	'|turn|1',
	'|move|p2a: Swampert|Earthquake|p1a: Pikachu',
	'|-damage|p1a: Pikachu|41/100',
	'|-supereffective|p1a: Pikachu',
	'|move|p1a: Pikachu|Thunderbolt|p2a: Swampert',
	'|-damage|p2a: Swampert|60/100',
	'|-item|p2a: Swampert|Leftovers',
	'|turn|2',
	'|move|p2a: Swampert|Stealth Rock|p1a: Pikachu',
	'|-sidestart|p1|move: Stealth Rock',
	'|move|p1a: Pikachu|Thunderbolt|p2a: Swampert',
	'|-damage|p2a: Swampert|0 fnt',
	'|faint|p2a: Swampert',
	'|win|Ash',
].join('\n');

function buildState() {
	const t = new BattleTracker();
	// Feed a request message so myTeam is populated.
	const req = {
		side: {
			id: 'p1', name: 'Ash',
			pokemon: [
				{
					ident: 'p1: Pikachu', details: 'Pikachu, L88, M', condition: '41/100', active: true,
					stats: { atk: 112, def: 56, spa: 112, spd: 78, spe: 160 },
					moves: ['thunderbolt', 'voltswitch', 'surf', 'nuzzle'],
					baseAbility: 'static', ability: 'static', item: 'lightball', teraType: 'Electric',
				},
				{
					ident: 'p1: Charizard', details: 'Charizard, L85, F', condition: '100/100', active: false,
					stats: { atk: 140, def: 88, spa: 159, spd: 105, spe: 148 },
					moves: ['flamethrower', 'airslash', 'focusblast', 'roost'],
					baseAbility: 'blaze', ability: 'blaze', item: 'choicescarf', teraType: 'Fire',
				},
			],
		},
	};
	t.feed(BATTLE_FRAMES);
	t.feed(`|request|${JSON.stringify(req)}`);
	return t.state;
}

test('generateBattleLog returns a non-empty string', () => {
	const state = buildState();
	const log = generateBattleLog(state, [BATTLE_FRAMES], MOVES);
	assert.ok(typeof log === 'string' && log.length > 100);
});

test('BATTLE SUMMARY section contains expected fields', () => {
	const state = buildState();
	const log = generateBattleLog(state, [BATTLE_FRAMES], MOVES);
	assert.ok(log.includes('POKEMON SHOWDOWN BATTLE LOG'), 'missing header');
	assert.ok(log.includes('[Gen 9] Random Battle'), 'missing tier');
	assert.ok(log.includes('Ash') && log.includes('Gary'), 'missing player names');
	assert.ok(log.includes('Ash won'), 'missing result');
	assert.ok(log.includes('Turns:'), 'missing turn count');
});

test('PLAYER 1 TEAM section lists all team members with moves', () => {
	const state = buildState();
	const log = generateBattleLog(state, [BATTLE_FRAMES], MOVES);
	assert.ok(log.includes('PLAYER 1 TEAM'), 'missing section header');
	assert.ok(log.includes('Pikachu'), 'missing Pikachu');
	assert.ok(log.includes('Charizard'), 'missing Charizard');
	// Move details should include type/category/BP
	assert.ok(log.includes('Electric · Special · 90 BP'), 'missing move BP detail');
	assert.ok(log.includes('lightball'), 'missing item');
	assert.ok(log.includes('static'), 'missing ability');
});

test('PLAYER 2 TEAM section shows revealed moves and items', () => {
	const state = buildState();
	const log = generateBattleLog(state, [BATTLE_FRAMES], MOVES);
	assert.ok(log.includes('PLAYER 2 TEAM'), 'missing section header');
	assert.ok(log.includes('Swampert'), 'missing Swampert');
	assert.ok(log.includes('Leftovers'), 'missing revealed item');
	assert.ok(log.includes('FAINTED'), 'missing fainted status');
	// Earthquake seen in battle
	assert.ok(log.includes('Earthquake'), 'Earthquake should appear in moves seen');
});

test('TURN-BY-TURN LOG contains per-turn blocks with annotated events', () => {
	const state = buildState();
	const log = generateBattleLog(state, [BATTLE_FRAMES], MOVES);
	assert.ok(log.includes('TURN-BY-TURN'), 'missing section header');
	assert.ok(log.includes('--- TURN 1 ---'), 'missing turn 1 header');
	assert.ok(log.includes('--- TURN 2 ---'), 'missing turn 2 header');
	// Damage should be annotated as percentages
	assert.ok(log.includes('100% →'), 'missing before damage %');
	// Super effective annotation
	assert.ok(log.includes('super effective'), 'missing effectiveness annotation');
	// Faint annotation
	assert.ok(log.includes('FAINTED') || log.includes('fainted'), 'missing faint in turn log');
});

test('FIELD STATE section appears', () => {
	const state = buildState();
	const log = generateBattleLog(state, [BATTLE_FRAMES], MOVES);
	assert.ok(log.includes('FIELD STATE AT END'), 'missing field state section');
	// Stealth Rock was set on p1's side
	assert.ok(log.includes('Stealth Rock'), 'missing Stealth Rock in side conditions');
});

test('LLM coaching prompt is not appended to the log', () => {
	const state = buildState();
	const log = generateBattleLog(state, [BATTLE_FRAMES], MOVES);
	// The coaching prompt was removed — the log ends at the raw protocol appendix.
	assert.ok(!log.includes('LLM ANALYSIS PROMPT'), 'analysis prompt should be gone');
	assert.ok(!log.includes('OUTCOME DRIVERS'), 'coaching questions should be gone');
	assert.ok(log.includes('RAW PROTOCOL'), 'raw protocol section should remain');
});

test('generateBattleLog handles empty/minimal state gracefully', () => {
	const t = new BattleTracker();
	const state = t.state; // empty
	const log = generateBattleLog(state, [], {});
	assert.ok(typeof log === 'string');
	assert.ok(log.includes('POKEMON SHOWDOWN BATTLE LOG'));
	assert.ok(log.includes('IN PROGRESS'));
	assert.ok(log.includes('nothing revealed yet') || log.includes('no team data'));
});

test('stat boost context appears in turn log when Dragon Dance used', () => {
	const t = new BattleTracker();
	t.feed([
		'>battle-gen9randombattle-50',
		'|switch|p2a: Dragonite|Dragonite, L80, M|100/100',
		'|switch|p1a: Pikachu|Pikachu, L88, M|100/100',
		'|turn|1',
		'|move|p2a: Dragonite|Dragon Dance|p2a: Dragonite',
		'|-boost|p2a: Dragonite|atk|1',
		'|-boost|p2a: Dragonite|spe|1',
		'|win|Pikachu',
	].join('\n'));
	const log = generateBattleLog(t.state, [], MOVES);
	assert.ok(log.includes('Dragon Dance'), 'Dragon Dance not in log');
	assert.ok(log.includes('Attack') || log.includes('+1'), 'boost not annotated');
});

test('weather and hazard changes appear in turn log', () => {
	const t = new BattleTracker();
	t.feed([
		'>battle-gen9randombattle-51',
		'|switch|p2a: Swampert|Swampert, L82, M|100/100',
		'|switch|p1a: Pikachu|Pikachu, L88, M|100/100',
		'|turn|1',
		'|-weather|RainDance',
		'|-sidestart|p2|move: Stealth Rock',
		'|-fieldstart|move: Trick Room',
		'|win|Pikachu',
	].join('\n'));
	const log = generateBattleLog(t.state, [], MOVES);
	assert.ok(log.includes('Rain'), 'weather not in log');
	assert.ok(log.includes('Stealth Rock'), 'hazard not in log');
	assert.ok(log.includes('Trick Room'), 'pseudo-weather not in log');
});
