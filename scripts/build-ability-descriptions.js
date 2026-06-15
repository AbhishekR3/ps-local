/* eslint-disable security/detect-object-injection */
// Builds helper/extension/data/abilities-desc.json — ability display names + one-line descriptions
// for the battle helper.
//
// Sources from the vendored PS submodule, imported directly via Node type-stripping (Node >= 22.6,
// same mechanism as build-data.js — no scraping, always in sync after `npm run update-upstream`):
//   - data/text/abilities.ts (AbilitiesText: shortDesc / desc / name per ability id)
//   - data/abilities.ts      (Abilities: canonical display name)
//
// Output shape: { "<abilityid>": { "displayName": "Magic Guard", "description": "..." }, ... }
// Re-run after any update-upstream that touches abilities (rare):  npm run build:ability-desc
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', 'vendor', 'pokemon-showdown');
const OUT = join(HERE, '..', 'helper', 'extension', 'data', 'abilities-desc.json');

// eslint-disable-next-line no-unsanitized/method -- Node build script; no DOM
const { AbilitiesText } = await import(join(REPO, 'data', 'text', 'abilities.ts'));
// eslint-disable-next-line no-unsanitized/method -- Node build script; no DOM
const { Abilities } = await import(join(REPO, 'data', 'abilities.ts'));

// Last-resort name when neither table carries one — turns an id into "Magicguard" (no spaces, but
// real abilities always have a canonical name, so this only fires for stray ids).
const titleCase = (id) => id.charAt(0).toUpperCase() + id.slice(1);

const out = {};
for (const id in AbilitiesText) {
	const t = AbilitiesText[id];
	const displayName = Abilities[id]?.name || t.name || titleCase(id);
	// Prefer the one-line shortDesc; if absent, fall back to the full desc truncated to ~80 chars.
	let description = t.shortDesc || t.desc || '';
	if (!t.shortDesc && t.desc && t.desc.length > 80) description = t.desc.slice(0, 80).trimEnd() + '…';
	out[id] = { displayName, description };
}

writeFileSync(OUT, JSON.stringify(out));
console.log(`abilities-desc.json: ${Object.keys(out).length} abilities`);
