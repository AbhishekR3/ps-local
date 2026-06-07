// Golden-file test: regenerate the rich log for the canonical fixture battle and assert it matches a
// checked-in expected output byte-for-byte (after normalizing the one volatile line). This catches
// *any* unintended change to exporter formatting that the section-anchor assertions would miss.
//
// If a change to the exporter is intentional, regenerate the golden:
//   node helper/test/golden.test.js --update
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BattleTracker } from '../extension/lib/parser.js';
import { generateBattleLog } from '../extension/lib/exporter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = join(HERE, 'fixtures', 'sample-battle.txt');
const goldenPath = join(HERE, 'golden', 'sample-battle.expected.txt');
const movesPath = join(HERE, '..', 'extension', 'data', 'moves.json');

// `Generated: <localized date>` is the only non-deterministic line; pin it so the golden is stable.
const normalize = (s) => s.replace(/^Generated: .*$/m, 'Generated: <NORMALIZED>');

function render() {
  const text = readFileSync(fixture, 'utf8').replace(/\r/g, '');
  const frames = text.split('\n');
  const moves = JSON.parse(readFileSync(movesPath, 'utf8'));
  const t = new BattleTracker();
  for (const line of frames) t.feed(line);
  return normalize(generateBattleLog(t.state, frames, moves, 'UTC'));
}

// `node helper/test/golden.test.js --update` rewrites the golden after an intentional exporter change.
if (process.argv.includes('--update')) {
  writeFileSync(goldenPath, render());
  console.log('golden updated:', goldenPath);
} else {
  test('rich log matches the checked-in golden for sample-battle.txt', () => {
    const expected = readFileSync(goldenPath, 'utf8');
    assert.equal(render(), expected,
      'exporter output drifted from golden. If intentional, run: node helper/test/golden.test.js --update');
  });
}
