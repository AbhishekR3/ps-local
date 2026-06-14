// Unit tests for the pure log-writer helpers (extension/lib/logmeta.js) extracted from the Electron
// main process. These run under `node --test` with no Electron runtime — the whole point of the
// extraction (the §9 highest-leverage coverage: roomid parse, filename scheme, end-detection).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomidOf, sanitize, battleLogFilename, battleEndReason } from '../extension/lib/logmeta.js';

test('roomidOf parses the battle id from a frame first line', () => {
	assert.equal(roomidOf('>battle-gen9ou-12345'), 'battle-gen9ou-12345');
	assert.equal(roomidOf('>battle-gen9randombattle-1\n|init|battle'), 'battle-gen9randombattle-1');
	assert.equal(roomidOf('>  battle-gen9ou-9 '), 'battle-gen9ou-9'); // leading space tolerated
});

test('roomidOf returns null for non-room frames', () => {
	assert.equal(roomidOf('|init|battle'), null);     // no '>' prefix
	assert.equal(roomidOf('>lobby'), null);           // not a battle room
	assert.equal(roomidOf(''), null);
	assert.equal(roomidOf(null), null);
});

test('sanitize strips filename-unsafe characters', () => {
	assert.equal(sanitize('Some Player!'), 'Some_Player_');
	assert.equal(sanitize('a/b\\c'), 'a_b_c');
	assert.equal(sanitize(undefined), 'unknown');
	assert.equal(sanitize(''), 'unknown');
});

test('battleLogFilename builds the win/tie/inprogress scheme with a deterministic ts', () => {
	const base = { players: { p1: { name: 'You' }, p2: { name: 'Rival' } }, mySide: 'p1' };

	assert.equal(
		battleLogFilename('battle-gen9ou-1', { ...base, ended: true, winner: 'You' }, 1700),
		'battle-gen9ou-1_You_vs_Rival_WIN_You_1700');
	assert.equal(
		battleLogFilename('battle-gen9ou-1', { ...base, ended: true, winner: null }, 1700),
		'battle-gen9ou-1_You_vs_Rival_TIE_1700');
	assert.equal(
		battleLogFilename('battle-gen9ou-1', { ...base, ended: false }, 1700),
		'battle-gen9ou-1_You_vs_Rival_INPROGRESS_1700');
});

test('battleLogFilename uses the SPEC_ prefix when not a participant', () => {
	const spec = { players: { p1: { name: 'A' }, p2: { name: 'B' } }, mySide: null, ended: true, winner: 'A' };
	assert.equal(battleLogFilename('battle-gen9ou-2', spec, 42), 'battle-gen9ou-2_SPEC_A_vs_B_WIN_A_42');
});

test('battleEndReason detects win/deinit and ignores premature deinit', () => {
	assert.equal(battleEndReason('|win|You', 5), 'win');
	assert.equal(battleEndReason('|deinit', 3), 'deinit');
	assert.equal(battleEndReason('|deinit', 0), null);  // never-started room → no empty log
	assert.equal(battleEndReason('|turn|3', 3), null);
});

test('battleEndReason detects the real |tie frame and ignores chat lookalikes', () => {
	// The real protocol tie frame is `|tie` (no trailing pipe), one line of its own — see
	// fixtures/tie-battle.txt. Line-anchored /^\|tie\b/m catches it within a multi-line frame.
	assert.equal(battleEndReason('|tie', 5), 'tie');
	assert.equal(battleEndReason('>battle-gen9ou-1\n|turn|5\n|tie', 5), 'tie');
	assert.equal(battleEndReason('|tie|legacy', 5), 'tie'); // a trailing pipe still counts
	// Chat that merely contains "tie" must NOT end the battle (the bare /\|tie/ false-positive).
	assert.equal(battleEndReason('|c|user|tie game!', 5), null);
});
