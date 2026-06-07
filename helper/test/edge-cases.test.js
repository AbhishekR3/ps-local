// Edge-case battle endings: tie and forfeit. These drive whole fixture files through the
// parser -> exporter path and assert the result resolves correctly (not stuck IN PROGRESS), since
// result derivation is a common breakage point on upstream protocol changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BattleTracker } from '../extension/lib/parser.js';
import { generateBattleLog } from '../extension/lib/exporter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const render = (fixtureName) => {
  const text = readFileSync(join(HERE, 'fixtures', fixtureName), 'utf8').replace(/\r/g, '');
  const frames = text.split('\n');
  const t = new BattleTracker();
  for (const line of frames) t.feed(line);
  return generateBattleLog(t.state, frames, {});
};

test('tie battle (|tie) resolves to TIE', () => {
  const log = render('tie-battle.txt');
  assert.match(log, /Result:\s+TIE/, 'tie not resolved to TIE');
  assert.doesNotMatch(log, /Result:\s+IN PROGRESS/, 'tie left as IN PROGRESS');
});

test('opponent forfeit resolves to YOU WON', () => {
  const log = render('forfeit-battle.txt');
  assert.match(log, /Result:\s+YOU WON/, 'forfeit win not resolved');
});

test('an unfinished battle stays IN PROGRESS', () => {
  // sample-battle without the trailing |win| line should not claim a result.
  const text = readFileSync(join(HERE, 'fixtures', 'sample-battle.txt'), 'utf8').replace(/\r/g, '');
  const frames = text.split('\n').filter((l) => !l.startsWith('|win|'));
  const t = new BattleTracker();
  for (const line of frames) t.feed(line);
  const log = generateBattleLog(t.state, frames, {});
  assert.match(log, /Result:\s+IN PROGRESS/, 'unfinished battle should be IN PROGRESS');
});
