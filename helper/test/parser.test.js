import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BattleTracker, parseDetails, parseIdent, parseCondition } from '../extension/lib/parser.js';

test('parseDetails extracts species/level/gender/shiny/tera', () => {
	assert.deepEqual(parseDetails('Swampert, L82, M'), { species: 'Swampert', level: 82, gender: 'M', shiny: false, tera: null });
	assert.deepEqual(parseDetails('Charizard, L85, F, shiny, tera:Fire'),
		{ species: 'Charizard', level: 85, gender: 'F', shiny: true, tera: 'Fire' });
	assert.equal(parseDetails('Ditto').level, 100);
});

test('parseIdent splits side/pos/nickname', () => {
	assert.deepEqual(parseIdent('p2a: Big Mud'), { side: 'p2', pos: 'a', slot: 'p2a', name: 'Big Mud' });
	assert.deepEqual(parseIdent('p1: Lizard'), { side: 'p1', pos: '', slot: 'p1', name: 'Lizard' });
});

test('parseCondition handles hp/status/faint', () => {
	assert.deepEqual(parseCondition('82/100 brn'), { hp: 82, maxhp: 100, status: 'brn', fainted: false });
	assert.deepEqual(parseCondition('0 fnt'), { hp: 0, maxhp: 100, status: 'fnt', fainted: true });
});

const FRAME = [
	'>battle-gen9randomdoublesbattle-99887766',
	'|init|battle',
	'|gen|9',
	'|gametype|doubles',
	'|tier|[Gen 9] Random Doubles Battle',
	'|player|p1|You|1|',
	'|player|p2|Rival|2|',
	'|clearpoke',
	'|poke|p2|Swampert, L82, M|item',
	'|poke|p2|Charizard, L82, M|item',
	'|teampreview',
	'|start',
	'|switch|p1a: Pikachu|Pikachu, L88, M|100/100',
	'|switch|p2a: Swampert|Swampert, L82, M|100/100',
	'|switch|p2b: Charizard|Charizard, L82, M|100/100',
	'|turn|1',
	'|move|p2a: Swampert|Earthquake|p1a: Pikachu',
	'|-damage|p1a: Pikachu|41/100',
	'|-ability|p2b: Charizard|Blaze',
	'|-item|p2a: Swampert|Leftovers',
].join('\n');

test('tracker builds full battle state from a frame', () => {
	const t = new BattleTracker();
	const s = t.feed(FRAME);

	assert.equal(s.formatId, 'gen9randomdoublesbattle');
	assert.equal(s.gen, 9);
	assert.equal(s.gameType, 'doubles');
	assert.equal(s.turn, 1);

	// Active field
	assert.equal(s.active.p2a.species, 'Swampert');
	assert.equal(s.active.p2a.item, 'Leftovers');
	assert.equal(s.active.p2b.species, 'Charizard');
	assert.equal(s.active.p2b.ability, 'Blaze');
	assert.equal(s.active.p1a.hp, 41);

	// Opponent reveals (from team preview + switches)
	assert.ok(s.revealed.p2.swampert);
	assert.ok(s.revealed.p2.charizard);
	assert.equal(s.revealed.p2.swampert.item, 'Leftovers');
	assert.equal(s.revealed.p2.charizard.ability, 'Blaze');
});

test('move records the used move under the user revealed record', () => {
	const t = new BattleTracker();
	t.feed([
		'>battle-gen9randombattle-8',
		'|switch|p2a: Swampert|Swampert, L82, M|100/100',
		'|move|p2a: Swampert|Earthquake|p1a: Pikachu',
		'|move|p2a: Swampert|Ice Beam|p1a: Pikachu',
	].join('\n'));
	const rec = t.state.revealed.p2.swampert;
	assert.ok(rec.moves instanceof Set);
	assert.deepEqual([...rec.moves].sort(), ['earthquake', 'icebeam']);
});

test('items revealed via [from] item: tags are recorded as confirmed', () => {
	const t = new BattleTracker();
	t.feed([
		'>battle-gen9randomdoublesbattle-20',
		'|switch|p2a: Blissey|Blissey, L80, F|100/100',
		'|switch|p2b: Ferrothorn|Ferrothorn, L84, M|100/100',
		'|switch|p1a: Pikachu|Pikachu, L84, M|100/100',
		'|-heal|p2a: Blissey|100/100|[from] item: Leftovers',
		'|-damage|p1a: Pikachu|88/100|[from] item: Rocky Helmet|[of] p2b: Ferrothorn',
	].join('\n'));
	assert.equal(t.state.revealed.p2.blissey.item, 'Leftovers'); // healed holder
	assert.equal(t.state.revealed.p2.ferrothorn.item, 'Rocky Helmet'); // [of] owner, not the victim
	assert.equal(t.state.revealed.p1.pikachu.item, null); // victim didn't reveal an item
});

test('enditem records the consumed item as confirmed', () => {
	const t = new BattleTracker();
	t.feed([
		'>battle-gen9randombattle-21',
		'|switch|p2a: Garchomp|Garchomp, L78, M|100/100',
		'|-enditem|p2a: Garchomp|Sitrus Berry|[eat]',
	].join('\n'));
	assert.equal(t.state.revealed.p2.garchomp.item, 'Sitrus Berry');
	assert.equal(t.state.active.p2a.item, null); // consumed -> active slot cleared
});

test('a knocked-off item is attributed to its holder, not the knocker', () => {
	const t = new BattleTracker();
	t.feed([
		'>battle-gen9randombattle-22',
		'|switch|p1a: Tyranitar|Tyranitar, L80, M|100/100',
		'|switch|p2a: Weavile|Weavile, L80, M|100/100',
		'|-enditem|p1a: Tyranitar|Leftovers|[from] move: Knock Off|[of] p2a: Weavile',
	].join('\n'));
	assert.equal(t.state.revealed.p1.tyranitar.item, 'Leftovers'); // holder = ident
	assert.equal(t.state.revealed.p2.weavile.item, null); // the knocker keeps its own (unknown) item
});

test('deinit marks the room closed', () => {
	const t = new BattleTracker();
	t.feed('>battle-gen9randombattle-9\n|gen|9\n|switch|p2a: Ditto|Ditto|100/100');
	assert.equal(t.state.closed, false);
	t.feed('>battle-gen9randombattle-9\n|deinit');
	assert.equal(t.state.closed, true);
});

test('faint marks both the active slot and the revealed record', () => {
	const t = new BattleTracker();
	t.feed([
		'>battle-gen9randombattle-7',
		'|switch|p2a: Swampert|Swampert, L82, M|100/100',
		'|faint|p2a: Swampert',
	].join('\n'));
	assert.equal(t.state.active.p2a.fainted, true);
	assert.equal(t.state.active.p2a.hp, 0);
	assert.equal(t.state.revealed.p2.swampert.fainted, true);
});

test('new battle room resets state', () => {
	const t = new BattleTracker();
	t.feed('>battle-gen9randombattle-1\n|gen|9\n|switch|p2a: Ditto|Ditto|100/100');
	assert.ok(t.state.revealed.p2.ditto);
	t.feed('>battle-gen9randombattle-2\n|gen|9');
	assert.equal(t.state.revealed.p2.ditto, undefined);
	assert.equal(t.state.formatId, 'gen9randombattle');
});

test('stat boosts accumulate and reset on switch', () => {
	const t = new BattleTracker();
	t.feed([
		'>battle-gen9randombattle-30',
		'|switch|p2a: Dragonite|Dragonite, L80, M|100/100',
		'|turn|1',
		'|move|p2a: Dragonite|Dragon Dance|p2a: Dragonite',
		'|-boost|p2a: Dragonite|atk|1',
		'|-boost|p2a: Dragonite|spe|1',
		'|turn|2',
		'|move|p2a: Dragonite|Dragon Dance|p2a: Dragonite',
		'|-boost|p2a: Dragonite|atk|1',
		'|-boost|p2a: Dragonite|spe|1',
	].join('\n'));
	assert.equal(t.state.boosts.p2a?.atk, 2);
	assert.equal(t.state.boosts.p2a?.spe, 2);

	// Switch out resets boosts
	t.feed('|switch|p2a: Swampert|Swampert, L82, M|100/100');
	assert.equal(t.state.boosts.p2a, undefined);
});

test('unboost, setboost, clearboost, clearallboost', () => {
	const t = new BattleTracker();
	t.feed([
		'>battle-gen9randombattle-31',
		'|switch|p2a: Gyarados|Gyarados, L80, M|100/100',
		'|switch|p1a: Pikachu|Pikachu, L88, M|100/100',
		'|turn|1',
		'|-boost|p2a: Gyarados|atk|2',
		'|-unboost|p2a: Gyarados|atk|1',
		'|-setboost|p2a: Gyarados|spe|3',
	].join('\n'));
	assert.equal(t.state.boosts.p2a.atk, 1);
	assert.equal(t.state.boosts.p2a.spe, 3);

	t.feed('|-clearboost|p2a: Gyarados');
	assert.deepEqual(t.state.boosts.p2a, { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, acc: 0, eva: 0 });

	t.feed([
		'|-boost|p2a: Gyarados|atk|2',
		'|-boost|p1a: Pikachu|spe|1',
		'|-clearallboost',
	].join('\n'));
	assert.deepEqual(t.state.boosts, {});
});

test('weather and terrain tracked', () => {
	const t = new BattleTracker();
	t.feed([
		'>battle-gen9randombattle-32',
		'|turn|1',
		'|-weather|RainDance',
		'|-terrain|ElectricTerrain',
	].join('\n'));
	assert.equal(t.state.weather, 'RainDance');
	assert.equal(t.state.terrain, 'ElectricTerrain');

	t.feed('|-weather|none');
	assert.equal(t.state.weather, null);
	t.feed('|-terrain|none');
	assert.equal(t.state.terrain, null);
});

test('side conditions accumulate layers and clear', () => {
	const t = new BattleTracker();
	t.feed([
		'>battle-gen9randombattle-33',
		'|turn|1',
		'|-sidestart|p1|move: Spikes',
		'|-sidestart|p1|move: Spikes',
		'|-sidestart|p2|move: Stealth Rock',
		'|-sidestart|p1|move: Reflect',
	].join('\n'));
	assert.equal(t.state.sideConditions.p1.Spikes, 2);
	assert.equal(t.state.sideConditions.p1.Reflect, 1);
	assert.equal(t.state.sideConditions.p2['Stealth Rock'], 1);

	t.feed('|-sideend|p1|move: Reflect');
	assert.equal(t.state.sideConditions.p1.Reflect, undefined);
});

test('pseudo-weather (Trick Room) tracked', () => {
	const t = new BattleTracker();
	t.feed([
		'>battle-gen9randombattle-34',
		'|turn|1',
		'|-fieldstart|move: Trick Room',
	].join('\n'));
	assert.equal(t.state.pseudoWeather['Trick Room'], 1);

	t.feed('|-fieldend|move: Trick Room');
	assert.equal(t.state.pseudoWeather['Trick Room'], undefined);
});

test('volatile status tracked and cleared on switch', () => {
	const t = new BattleTracker();
	t.feed([
		'>battle-gen9randombattle-35',
		'|switch|p2a: Gengar|Gengar, L80, M|100/100',
		'|turn|1',
		'|-start|p2a: Gengar|move: Substitute',
		'|-start|p2a: Gengar|confusion',
	].join('\n'));
	assert.equal(t.state.volatiles.p2a?.Substitute, true);
	assert.equal(t.state.volatiles.p2a?.confusion, true);

	t.feed('|-end|p2a: Gengar|Substitute');
	assert.equal(t.state.volatiles.p2a?.Substitute, undefined);

	// Switch clears all volatiles
	t.feed('|switch|p2a: Swampert|Swampert, L82, M|100/100');
	assert.equal(t.state.volatiles.p2a, undefined);
});

test('turnLog groups lines per turn and captures winner', () => {
	const t = new BattleTracker();
	t.feed([
		'>battle-gen9randombattle-36',
		'|switch|p2a: Swampert|Swampert, L82, M|100/100',
		'|switch|p1a: Pikachu|Pikachu, L88, M|100/100',
		'|turn|1',
		'|move|p2a: Swampert|Earthquake|p1a: Pikachu',
		'|-damage|p1a: Pikachu|41/100',
		'|turn|2',
		'|move|p1a: Pikachu|Thunderbolt|p2a: Swampert',
		'|-damage|p2a: Swampert|0 fnt',
		'|faint|p2a: Swampert',
		'|win|Pikachu',
	].join('\n'));

	assert.equal(t.state.turn, 2);
	assert.equal(t.state.winner, 'Pikachu');
	assert.equal(t.state.ended, true);

	// Turn 1 was flushed when |turn|2 arrived
	const t1 = t.state.turnLog.find((e) => e.num === 1);
	assert.ok(t1, 'turn 1 entry missing');
	assert.ok(t1.lines.some((l) => l.includes('Earthquake')), 'turn 1 should contain Earthquake');

	// Turn 2 was flushed when |win| arrived
	const t2 = t.state.turnLog.find((e) => e.num === 2);
	assert.ok(t2, 'turn 2 entry missing');
	assert.ok(t2.lines.some((l) => l.includes('Thunderbolt')), 'turn 2 should contain Thunderbolt');
});

test('parses my team from a request message', () => {
	const t = new BattleTracker();
	t.feed('>battle-gen9randombattle-5');
	const req = {
		side: {
			id: 'p1', name: 'You',
			pokemon: [{
				ident: 'p1: Pikachu', details: 'Pikachu, L88, M', condition: '100/100', active: true,
				stats: { atk: 100, def: 80, spa: 120, spd: 90, spe: 150 },
				moves: ['thunderbolt', 'voltswitch', 'surf', 'nuzzle'],
				baseAbility: 'static', item: 'lightball', teraType: 'Electric',
			}],
		},
	};
	t.feed(`|request|${JSON.stringify(req)}`);
	assert.equal(t.state.mySide, 'p1');
	assert.equal(t.state.myTeam.length, 1);
	assert.equal(t.state.myTeam[0].species, 'Pikachu');
	assert.deepEqual(t.state.myTeam[0].moves, ['thunderbolt', 'voltswitch', 'surf', 'nuzzle']);
	assert.equal(t.state.myTeam[0].item, 'lightball');
});
