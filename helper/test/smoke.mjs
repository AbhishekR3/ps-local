// Fast smoke test — drives the real fixture battle through the pure parser -> exporter path and
// asserts the rich log has its key sections. Standalone (not a node:test file) so it runs in CI as a
// single quick command and, crucially, EXITS NON-ZERO on failure: `assert` throws, unlike the old
// inline `console.assert` which only printed to stderr and never failed the step.
//
// Run: npm run test:smoke
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BattleTracker } from '../extension/lib/parser.js';
import { generateBattleLog } from '../extension/lib/exporter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = join(HERE, 'fixtures', 'sample-battle.txt');

const text = readFileSync(fixture, 'utf8').replace(/\r/g, '');
const frames = text.split('\n');

const tracker = new BattleTracker();
for (const line of frames) tracker.feed(line);

const log = generateBattleLog(tracker.state, frames, {});

// The exporter is contractually synchronous and must always emit these section anchors.
assert.ok(typeof log === 'string' && log.length > 0, 'log is empty');
assert.match(log, /POKEMON SHOWDOWN BATTLE LOG/, 'missing summary header');
assert.match(log, /TURN-BY-TURN/, 'missing TURN-BY-TURN section');
assert.match(log, /LLM ANALYSIS PROMPT/, 'missing analysis prompt section');
// sample-battle.txt ends in |win|PlayerOne — result must resolve, not stay IN PROGRESS.
assert.match(log, /\bwon\b|TIE/, 'result not resolved from a finished battle');

console.log('Protocol smoke: PASS');
