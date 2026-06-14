// Loads the bundled JSON data (helper/extension/data) inside the renderer.
// Mirrors helper/extension/lib/data.js — pokedex/moves loaded once; per-format
// tables loaded lazily and cached. Uses Vite glob so all gens are reachable
// without hardcoding each file.

/* eslint-disable @typescript-eslint/no-explicit-any */

const files = import.meta.glob('../../../helper/extension/data/**/*.json')

const cache = new Map<string, unknown>()

async function loadJson(suffix: string): Promise<any> {
  if (cache.has(suffix)) return cache.get(suffix)
  const hit = Object.entries(files).find(([p]) => p.endsWith(suffix))
  if (!hit) {
    cache.set(suffix, null)
    return null
  }
  const mod = (await hit[1]()) as { default: unknown }
  cache.set(suffix, mod.default)
  return mod.default
}

export interface AbilityDesc { displayName: string; description: string }
export interface Core { pokedex: any; moves: any; abilitiesDesc: Record<string, AbilityDesc> }
export interface FormatData {
  sets: any; items: any; abilities: any; teras: any; movesFreq: any; stats: any
}

let _core: Core | null = null

export async function loadCore(): Promise<Core> {
  if (_core) return _core
  const [pokedex, moves, abilitiesDesc] = await Promise.all([
    loadJson('/pokedex.json'),
    loadJson('/moves.json'),
    loadJson('/abilities-desc.json'),
  ])
  _core = { pokedex, moves, abilitiesDesc: abilitiesDesc || {} }
  return _core
}

// Returns the per-format tables for a resolved sets key (e.g. "gen9").
// Any table we don't ship for that key comes back null (lookup handles it).
export async function loadFormat(key: string | null): Promise<FormatData> {
  if (!key) return { sets: null, items: null, abilities: null, teras: null, movesFreq: null, stats: null }
  const [sets, items, abilities, teras, movesFreq, stats] = await Promise.all([
    loadJson(`/sets/${key}.json`),
    loadJson(`/items/${key}.json`),
    loadJson(`/abilities/${key}.json`),
    loadJson(`/tera/${key}.json`),
    loadJson(`/moves-freq/${key}.json`),
    loadJson(`/stats/${key}.json`),
  ])
  return { sets, items, abilities, teras, movesFreq, stats }
}
