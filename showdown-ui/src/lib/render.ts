// HTML render of the battle state — ported verbatim from helper/extension/panel.js
// so the native helper matches the extension exactly. The only change from the
// original is the category-icon src (served from /icons/ in this app instead of
// the extension's relative path). Functions take (state, core, fmt) explicitly
// rather than reading module globals.

/* eslint-disable @typescript-eslint/no-explicit-any */

// @ts-ignore — pure ESM JS lib, no TS declarations
import { getBreakdown } from '../../../helper/extension/lib/lookup.js'
import type { Core, FormatData } from './data'

const esc = (s: any): string => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
))

const idOf = (s: any): string => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')

function opponentSide(state: any): string {
  const me = state.mySide
  if (me) return me === 'p1' ? 'p2' : 'p1'
  return 'p2'
}

// True when watching someone else's battle — no |request| ever arrives so mySide stays null,
// but players and revealed data for both sides are still populated.
function isSpectating(s: any): boolean {
  return s.mySide === null && s.formatId !== null
}

// Format detection mirroring the PS client (battle-tooltips.ts getSpeedRange). Random-battle
// formats assume neutral nature + ≤84 EVs; everything else allows ±nature + 252 EVs.
function formatMeta(s: any): { isRandbat: boolean; gen: number } {
  const tier = String(s?.tier ?? '')
  const fid = String(s?.formatId ?? '')
  const isRandbat = /Random Battle/i.test(tier) || /Computer-Generated Teams/i.test(tier) || /random/.test(fid)
  const gm = fid.match(/^gen(\d+)/) || tier.match(/Gen\s*(\d+)/i)
  return { isRandbat, gen: gm ? Number(gm[1]) : 9 }
}

// Opponent stat range, ported from the PS client's getSpeedRange (battle-tooltips.ts) and
// generalized from Speed to every stat, so the panel matches the "Spe X or Y" the PS hover shows.
// `lo` always assumes 0 IV / 0 EV; `hi` assumes max IV + the format's max EVs. Random battles use a
// neutral nature and an 84-EV cap; standard formats use ±nature and 252 EVs.
function statBounds(base: number, level: number, isHP: boolean, isRandbat: boolean, gen: number) {
  const tr = Math.trunc
  const maxIv = gen < 3 ? 30 : 31
  // Gen 1-2 have no nature and always allow full stat experience (offset 63), even in randbats.
  const evMaxOffset = gen < 3 ? 63 : (isRandbat ? 21 : 63) // floor(84/4)=21 ; floor(252/4)=63
  if (isHP) {
    if (base === 1) return { lo: 1, hi: 1 } // Shedinja
    const lo = tr(2 * base * level / 100) + level + 10
    const hi = tr((2 * base + maxIv + evMaxOffset) * level / 100) + level + 10
    return { lo, hi }
  }
  const minNature = (isRandbat || gen < 3) ? 1 : 0.9
  const maxNature = (isRandbat || gen < 3) ? 1 : 1.1
  const lo = tr(tr(2 * base * level / 100 + 5) * minNature)
  const hi = tr(tr((2 * base + maxIv + evMaxOffset) * level / 100 + 5) * maxNature)
  return { lo, hi }
}

// Like statBounds but prefers the empirically recorded min/max when available.
// `emp` comes from stats/genN.json and reflects real generator EV/IV/nature rolls.
function resolvedBounds(base: number, level: number, isHP: boolean, isRandbat: boolean, gen: number, emp: { min: number; max: number } | null) {
  if (!isHP && emp) return { lo: emp.min, hi: emp.max }
  return statBounds(base, level, isHP, isRandbat, gen)
}

// `max` sets the bar's full-scale value. `display` overrides the label text.
function statBar(label: string, value: number, max = 200, display: string | null = null): string {
  const cap = max * 0.75
  const pct = Math.min(100, Math.round((value / max) * 100))
  const hue = Math.round((Math.min(value, cap) / cap) * 120) // red -> green
  return `<div class="stat"><span class="stat-l">${label}</span>`
    + `<span class="stat-bar"><i style="width:${pct}%;background:hsl(${hue} 70% 45%)"></i></span>`
    + `<span class="stat-v">${display ?? value}</span></div>`
}

// Like statBar but the value is only known to a guaranteed range [lo, hi] (opponents). Reads the same
// as statBar — a solid fill from 0 — so the bar length still encodes magnitude. The lo→hi uncertainty
// is a lighter translucent segment layered on the end (the "fuzzy tip"); when lo === hi it's just a
// solid bar, no detached sliver. Label text shows "lo–hi" (or a single number when lo === hi).
function statRangeBar(label: string, lo: number, hi: number, max = 200): string {
  const cap = max * 0.75
  const loPct = Math.min(100, Math.round((lo / max) * 100))
  const hiPct = Math.min(100, Math.round((hi / max) * 100))
  const extPct = Math.max(hiPct - loPct, 0) // translucent extension width (0 when lo === hi)
  const hue = Math.round((Math.min(hi, cap) / cap) * 120) // red -> green, keyed on the high end
  const disp = lo === hi ? String(lo) : `${lo}–${hi}`
  return `<div class="stat"><span class="stat-l">${label}</span>`
    + `<span class="stat-bar"><i style="width:${loPct}%;background:hsl(${hue} 70% 45%)"></i>`
    + `<u style="width:${extPct}%;background:hsl(${hue} 70% 45%)"></u></span>`
    + `<span class="stat-v">${disp}</span></div>`
}

function typeTags(types: string[]): string {
  return types.map((t) => `<span class="type t-${esc(t.toLowerCase())}">${esc(t)}</span>`).join('')
}

function moveChip(m: any, hideFreq = false): string {
  const cat = esc(m.category.toLowerCase())
  const bp = m.basePower ? ` ${m.basePower}` : ''
  const freqSuffix = m.freq != null ? ` · ${m.freq}% of sets` : ''
  const freqBadge = (!hideFreq && m.freq != null) ? ` <span class="muted">${m.freq}%</span>` : ''
  // `used` (set by lookup) marks a predicted move the opponent has already revealed.
  return `<span class="move cat-${cat}${m.used ? ' used' : ''}" title="${esc(m.category)} · ${esc(m.type)}${bp ? ' · ' + m.basePower + ' BP' : ''}${m.used ? ' · seen' : ''}${freqSuffix}">`
    + `<span class="type t-${esc(m.type.toLowerCase())}">${esc(m.type)}</span>${esc(m.name)}${bp}`
    + `<img class="cat-icon" src="/icons/categories/${esc(m.category)}.png" alt="${esc(m.category)}">${freqBadge}</span>`
}

function breakdownCard(species: string, reveal: any, core: Core, fmt: FormatData, meta: { isRandbat: boolean; gen: number }, activeHp: { hp: number; maxhp: number; status?: string } | null = null): string {
  const b = getBreakdown(species, { pokedex: core.pokedex, moves: core.moves, sets: fmt.sets, items: fmt.items, abilities: fmt.abilities, teras: fmt.teras, movesFreq: fmt.movesFreq }, reveal?.moves)
  const empStats = fmt.stats?.[b.id] ?? null
  const abilityDesc = (name: string): string => core.abilitiesDesc?.[idOf(name)]?.description ?? ''
  const abilityTip = (name: string): string => {
    const d = abilityDesc(name)
    return d ? ` title="${esc(d)}"` : ''
  }
  let stats = ''
  if (b.baseStats) {
    const level = reveal?.level || b.level
    if (level) {
      // Opponent stats are only known to a range. Show the same span the PS hover tooltip does,
      // using that format's spread rules (random battles: neutral nature + ≤84 EVs).
      const { isRandbat, gen } = meta
      const cs = {
        hp:  resolvedBounds(b.baseStats.hp,  level, true,  isRandbat, gen, null),
        atk: resolvedBounds(b.baseStats.atk, level, false, isRandbat, gen, empStats?.atk ?? null),
        def: resolvedBounds(b.baseStats.def, level, false, isRandbat, gen, empStats?.def ?? null),
        spa: resolvedBounds(b.baseStats.spa, level, false, isRandbat, gen, empStats?.spa ?? null),
        spd: resolvedBounds(b.baseStats.spd, level, false, isRandbat, gen, empStats?.spd ?? null),
        spe: resolvedBounds(b.baseStats.spe, level, false, isRandbat, gen, empStats?.spe ?? null),
      }
      const scale = Math.max(255, ...Object.values(cs).map((r) => r.hi))
      stats = `<div class="stats">${statRangeBar('HP', cs.hp.lo, cs.hp.hi, scale)}${statRangeBar('Atk', cs.atk.lo, cs.atk.hi, scale)}${statRangeBar('Def', cs.def.lo, cs.def.hi, scale)}`
        + `${statRangeBar('SpA', cs.spa.lo, cs.spa.hi, scale)}${statRangeBar('SpD', cs.spd.lo, cs.spd.hi, scale)}${statRangeBar('Spe', cs.spe.lo, cs.spe.hi, scale)}</div>`
    } else {
      stats = `<div class="stats">${statBar('HP', b.baseStats.hp)}${statBar('Atk', b.baseStats.atk)}${statBar('Def', b.baseStats.def)}`
        + `${statBar('SpA', b.baseStats.spa)}${statBar('SpD', b.baseStats.spd)}${statBar('Spe', b.baseStats.spe)}</div>`
    }
  }

  const known: string[] = []
  if (reveal?.ability) known.push(`<b>Ability:</b> ${esc(reveal.ability)}`)
  if (reveal?.item) known.push(`<b>Item:</b> ${esc(reveal.item)}`)
  const knownLine = known.length ? `<div class="known">${known.join(' · ')}</div>` : ''
  // One-line description beneath the revealed ability.
  const revealedAbilityDesc = reveal?.ability ? core.abilitiesDesc?.[idOf(reveal.ability)]?.description : null
  const abilityDescLine = revealedAbilityDesc ? `<div class="ability-desc">${esc(revealedAbilityDesc)}</div>` : ''

  // Predicted items — only when the real item hasn't been revealed yet.
  const itemLabel = (n: string) => (n === '(none)' ? 'No item' : n)
  const items = (!reveal?.item && b.predictedItems.length)
    ? `<div class="row"><span class="k">Likely items</span> ${b.predictedItems.map((p: any) => `<span class="pill">${esc(itemLabel(p.item))} <span class="muted">${p.pct}%</span></span>`).join('')}</div>` : ''

  const abilityPill = (name: string, pct?: number): string => {
    const d = abilityDesc(name)
    const descHtml = d ? `<span class="ability-pill-desc">${esc(d)}</span>` : ''
    return `<span class="pill ability-pill">${esc(name)}${pct != null ? ` <span class="muted">${pct}%</span>` : ''}${descHtml}</span>`
  }
  // Show predicted abilities (with Monte Carlo %) when the ability hasn't been revealed yet.
  const abilities = !reveal?.ability && b.abilities.length
    ? (b.predictedAbilities.length
      ? `<div class="row"><span class="k">Likely abilities</span> ${b.predictedAbilities.map((p: any) => abilityPill(p.ability, p.pct)).join('')}</div>`
      : `<div class="row"><span class="k">Possible abilities</span> ${b.abilities.map((a: any) => abilityPill(a)).join('')}</div>`)
    : ''
  // Tera: show Monte Carlo probabilities when available, else fall back to set-narrowed list.
  const teraChip = (t: string, pct: number | null) =>
    `<span class="pill"><span class="type t-${esc(t.toLowerCase())}">${esc(t)}</span>${pct != null ? ` <span class="muted">${pct}%</span>` : ''}</span>`
  const teras = b.teraTypes.length
    ? (b.predictedTeras.length
      ? `<div class="row"><span class="k">Likely tera</span> ${b.predictedTeras.map((p: any) => teraChip(p.teraType, p.pct)).join('')}</div>`
      : `<div class="row"><span class="k">Tera</span> ${b.teraTypes.map((t: string) => teraChip(t, null)).join('')}</div>`)
    : ''

  let setsHtml
  if (b.confirmed && b.relevantSets.length) {
    // All 4 moves revealed and set confirmed — show only the known moves, no probabilities.
    const confirmedSet = b.relevantSets[0]
    const knownMoves = confirmedSet.moves.filter((m: any) => m.used)
    setsHtml = `<div class="set confirmed">
      <div class="role">${esc(confirmedSet.role)}</div>
      <div class="moves">${knownMoves.map((m: any) => moveChip(m, true)).join('')}</div>
    </div>`
  } else if (b.found && b.relevantSets.length) {
    const note = b.lowConfidence
      ? `<div class="nodata">Revealed moves don't match any predicted set — showing closest by move overlap.</div>` : ''
    setsHtml = note + b.relevantSets.map((set: any) => {
      // Sort moves by freq descending (moves with no freq data sort to end).
      const sortedMoves = [...set.moves].sort((a: any, b: any) => (b.freq ?? -1) - (a.freq ?? -1))
      return `
      <div class="set">
        <div class="role">${esc(set.role)}${set.roleFreq != null ? ` <span class="match">${set.roleFreq}%</span>` : ''}${b.revealedCount ? ` <span class="match">${set.matchCount}/${b.revealedCount} seen</span>` : ''}</div>
        <div class="moves">${sortedMoves.map((m: any) => moveChip(m)).join('')}</div>
      </div>`
    }).join('')
  } else {
    setsHtml = `<div class="nodata">No predicted-set data for this format.</div>`
  }

  // Badge in the head once the revealed moves pin the set down — suppressed at possibleCount === 1,
  // since that lone set is already shown in full below the head, so the badge would be redundant.
  const headTag = b.confirmed
    ? `<span class="confirmed-tag">✓ set</span>`
    : (b.revealedCount && b.possibleCount && b.possibleCount > 1 && b.possibleCount < b.sets.length ? `<span class="match">${b.possibleCount} sets left</span>` : '')

  // Opponent HP% (+ status) for the active Pokémon, when the caller passes live HP.
  const hpTag = activeHp
    ? `<span class="hp">${Math.round(activeHp.hp / (activeHp.maxhp || 100) * 100)}%${activeHp.status ? ' ' + esc(activeHp.status) : ''}</span>`
    : ''

  return `
    <article class="card${reveal?.fainted ? ' fainted' : ''}">
      <div class="card-head">
        <span class="name">${esc(b.name)}</span>
        ${reveal?.fainted ? `<span class="fnt-tag">fnt</span>` : ''}
        ${hpTag}
        ${headTag}
        <span class="types">${typeTags(b.types)}</span>
      </div>
      ${knownLine}
      ${abilityDescLine}
      ${items}
      ${stats}
      ${abilities}
      ${teras}
      <div class="sets">${setsHtml}</div>
    </article>`
}

function ownMove(id: string, core: Core): any {
  return core.moves[id] || { name: id, type: '???', category: 'Status', basePower: 0 }
}

// Card for one of YOUR active Pokemon. We know the real set from |request| (myTeam),
// so we show actual stats/item/ability/moves rather than predictions.
function myActiveCard(p: any, team: any, core: Core): string {
  const dex = core.pokedex[idOf(p.species)] || null
  const hpPct = Math.round(p.hp / (p.maxhp || 100) * 100)
  const st = team?.stats
  const scale = st ? Math.max(255, p.maxhp, st.atk, st.def, st.spa, st.spd, st.spe) : 255
  const stats = st
    ? `<div class="stats">${statBar('HP', p.maxhp, scale)}${statBar('Atk', st.atk, scale)}${statBar('Def', st.def, scale)}`
      + `${statBar('SpA', st.spa, scale)}${statBar('SpD', st.spd, scale)}${statBar('Spe', st.spe, scale)}</div>`
    : ''

  const known: string[] = []
  const ability = team?.ability || p.ability
  if (ability) known.push(`<b>Ability:</b> ${esc(ability)}`)
  if (team?.item) known.push(`<b>Item:</b> ${esc(team.item)}`)
  const tera = team?.teraType || p.tera
  if (tera) known.push(`<b>Tera:</b> ${esc(tera)}`)
  const knownLine = known.length ? `<div class="known">${known.join(' · ')}</div>` : ''
  const abilityDesc = ability ? core.abilitiesDesc?.[idOf(ability)]?.description : null
  const abilityDescLine = abilityDesc ? `<div class="ability-desc">${esc(abilityDesc)}</div>` : ''

  const movesHtml = team?.moves?.length
    ? `<div class="moves">${team.moves.map((id: string) => moveChip(ownMove(id, core))).join('')}</div>` : ''

  return `
    <article class="card mine-card">
      <div class="card-head">
        <span class="name">${esc(p.species)}</span>
        <span class="hp">${hpPct}%${p.status ? ' ' + esc(p.status) : ''}</span>
        <span class="types">${typeTags(dex ? dex.types : [])}</span>
      </div>
      ${knownLine}
      ${abilityDescLine}
      ${stats}
      ${movesHtml}
    </article>`
}

export function waitingHtml(): string {
  return `<p class="hint">No active battle — waiting for the next game…</p>
<div class="hint-box">
  <b>Having issues?</b>
  <ul>
    <li>Start or accept a battle in the window on the left to begin tracking.</li>
    <li>To watch someone else's battle, open it from the Battle Search tab — the panel shows both players' Pokémon.</li>
    <li>Battle logs are saved automatically to <code>logs/battle_info/</code> — no manual save needed.</li>
  </ul>
</div>`
}

// Render one side's active + revealed bench as a labelled section block.
function renderSideHtml(s: any, side: string, label: string, core: Core, fmt: FormatData): string {
  const meta = formatMeta(s)
  const active = Object.values(s.active).filter((p: any) => p.side === side && !p.fainted)
  const activeIds = new Set(active.map((p: any) => idOf(p.species)))
  const bench = Object.entries(s.revealed[side] || {}).filter(([id]) => !activeIds.has(id))
  bench.sort(([, a]: any, [, b]: any) => (a.fainted === b.fainted ? 0 : a.fainted ? 1 : -1))

  let html = `<section><h2>${esc(label)} — active</h2>`
  html += active.length
    ? active.map((p: any) => breakdownCard(p.species, s.revealed[side]?.[idOf(p.species)], core, fmt, meta, { hp: p.hp, maxhp: p.maxhp, status: p.status })).join('')
    : `<p class="hint">No Pokémon on the field yet.</p>`
  html += `</section>`

  if (bench.length) {
    html += `<section><h2>${esc(label)} — bench</h2>`
    html += bench.map(([, rec]: any) => breakdownCard(rec.species, rec, core, fmt, meta)).join('')
    html += `</section>`
  }
  return html
}

export interface RenderResult { format: string; html: string }

export function renderBattle(s: any, core: Core | null, fmt: FormatData): RenderResult {
  // Room torn down (user left/closed the battle): clear the stale board.
  if (s.closed) {
    return { format: 'Waiting for next game…', html: waitingHtml() }
  }
  const format = s.tier || s.formatId || 'Waiting for a battle…'

  if (!core || !s.formatId) {
    return { format, html: waitingHtml() }
  }

  let html = ''

  if (isSpectating(s)) {
    // Spectator view — no |request| so no mySide; show both players' revealed data.
    const p1name = s.players.p1?.name || 'Player 1'
    const p2name = s.players.p2?.name || 'Player 2'
    if (s.ended) {
      const winnerLabel = s.winner ? `${esc(s.winner)} wins` : 'Tie'
      html += `<div class="banner">Battle over — ${winnerLabel}</div>`
    }
    html += renderSideHtml(s, 'p1', p1name, core, fmt)
    html += renderSideHtml(s, 'p2', p2name, core, fmt)
    return { format, html }
  }

  const meta = formatMeta(s)
  const opp = opponentSide(s)
  const active = Object.values(s.active).filter((p: any) => p.side === opp && !p.fainted)
  const activeIds = new Set(active.map((p: any) => idOf(p.species)))

  // Opponent's revealed-but-benched Pokemon (fainted sort to the bottom).
  const bench = Object.entries(s.revealed[opp] || {}).filter(([id]) => !activeIds.has(id))
  bench.sort(([, a]: any, [, b]: any) => (a.fainted === b.fainted ? 0 : a.fainted ? 1 : -1))

  const myActive = Object.values(s.active).filter((p: any) => p.side === s.mySide && !p.fainted)
  const myById: Record<string, any> = {}
  for (const t of s.myTeam) myById[idOf(t.species)] = t

  if (s.ended) html += `<div class="banner">Battle over — final board</div>`

  if (myActive.length) {
    html += `<section><h2>Your active</h2>`
      + myActive.map((p: any) => myActiveCard(p, myById[idOf(p.species)], core)).join('')
      + `</section>`
  }

  html += `<section><h2>Opponent active</h2>`
  html += active.length
    ? active.map((p: any) => breakdownCard(p.species, s.revealed[opp]?.[idOf(p.species)], core, fmt, meta, { hp: p.hp, maxhp: p.maxhp, status: p.status })).join('')
    : `<p class="hint">No opponent Pokémon on the field yet.</p>`
  html += `</section>`

  if (bench.length) {
    html += `<section><h2>Opponent revealed (bench)</h2>`
    html += bench.map(([, rec]: any) => breakdownCard(rec.species, rec, core, fmt, meta)).join('')
    html += `</section>`
  }

  return { format, html }
}
