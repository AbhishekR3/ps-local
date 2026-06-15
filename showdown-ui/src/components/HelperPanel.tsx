// Native battle-helper panel. Mirrors helper/extension/panel.js: owns a
// BattleTracker, feeds live frames relayed from main, coalesces renders into one
// per animation frame, and renders the exact same markup (see lib/render.ts).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from 'react'
// @ts-ignore — pure ESM JS lib, no TS declarations
import { BattleTracker } from '../../../helper/extension/lib/parser.js'
// @ts-ignore
import { resolveSetsKey } from '../../../helper/extension/lib/lookup.js'
import { loadCore, loadFormat, type Core, type FormatData } from '../lib/data'
import { renderBattle, waitingHtml } from '../lib/render'
import type { PsStatus } from '../global'

const EMPTY_FMT: FormatData = { sets: null, items: null, abilities: null, teras: null, stats: null, movesFreq: null }

const STALL_MS = 5000  // frames arriving but nothing parsed within this window → auto re-sync once

const DEFAULT_STATUS: PsStatus = { tap: 'unknown', page: 'ok', saveLogs: true, logWrite: 'ok' }

// Translate transport health + parse phase into the single status line shown above the panel. This
// is the fix for the system's #1 weakness: every silent failure (dead tap, offline PS, broken data)
// now has a visible, distinct message instead of an endless "Waiting…".
type Tone = 'ok' | 'idle' | 'warn' | 'error'
function deriveStatus(
  transport: PsStatus,
  phase: 'waiting' | 'connected',
  dataError: boolean,
): { text: string; tone: Tone; reload: boolean } {
  if (transport.page === 'unreachable') return { text: 'Pokémon Showdown site unreachable', tone: 'error', reload: true }
  if (transport.tap === 'error')         return { text: 'Tap not active — no battle frames will arrive', tone: 'error', reload: false }
  if (transport.logWrite === 'error')    return { text: 'Battle log failed to save — check disk space / folder permissions', tone: 'error', reload: false }
  if (dataError)                         return { text: 'Battle data failed to load', tone: 'error', reload: false }
  if (phase === 'connected') return { text: 'Connected', tone: 'ok', reload: false }
  return { text: 'Waiting for a battle…', tone: 'idle', reload: false }
}

export default function HelperPanel({ resyncSignal = 0 }: { resyncSignal?: number }) {
  const trackerRef = useRef<any>(null)
  if (!trackerRef.current) trackerRef.current = new BattleTracker()

  const coreRef = useRef<Core | null>(null)
  const fmtRef = useRef<FormatData>(EMPTY_FMT)
  const fmtKeyRef = useRef<string | null>(null)
  const rafRef = useRef(false)

  const framesSeenRef = useRef(0)
  const stallTimerRef = useRef<number | null>(null)
  const autoResyncedRef = useRef(false)  // guards against an auto-resync loop within one stuck episode
  const resyncRef = useRef<() => void>(() => {})

  const [format, setFormat] = useState('Waiting for a battle…')
  const [html, setHtml] = useState(waitingHtml())

  // Status-line inputs: transport health (from main), whether a battle has parsed, and data failures.
  const [transport, setTransport] = useState<PsStatus>(DEFAULT_STATUS)
  const [phase, setPhase] = useState<'waiting' | 'connected'>('waiting')
  const [dataError, setDataError] = useState(false)

  useEffect(() => {
    let cancelled = false

    const clearStall = () => {
      if (stallTimerRef.current != null) { clearTimeout(stallTimerRef.current); stallTimerRef.current = null }
    }

    // Resolve + cache the per-format tables when the format changes (like ensureSets).
    const ensureFormat = async () => {
      const key = resolveSetsKey(trackerRef.current.state.formatId)
      if (key !== fmtKeyRef.current) {
        fmtKeyRef.current = key
        fmtRef.current = await loadFormat(key)
      }
    }

    const doRender = async () => {
      rafRef.current = false
      try {
        await ensureFormat()
      } catch (e) {
        // loadFormat() rejected (e.g. a per-format JSON failed to import) — surface it, don't stall.
        if (!cancelled) setDataError(true)
        console.error('[PSH ui] format data failed to load', e)
        return
      }
      if (cancelled) return
      const res = renderBattle(trackerRef.current.state, coreRef.current, fmtRef.current)
      setFormat(res.format)
      setHtml(res.html)
      const parsed = !!trackerRef.current.state.formatId
      setPhase(parsed ? 'connected' : 'waiting')
      // A populated state means we're synced: drop any pending stall watch and re-arm for next time.
      if (parsed) {
        clearStall()
        autoResyncedRef.current = false
      }
    }

    // Coalesce bursts of frames into one render per animation frame.
    const scheduleRender = () => {
      if (rafRef.current) return
      rafRef.current = true
      requestAnimationFrame(() => { void doRender() })
    }

    // Rebuild the tracker from the buffered frames for the most-recent room. Recovers a battle whose
    // once-only |init|/|request| frames preceded this listener — a late mount, a new battle, a stall,
    // or a manual reset. feed() is idempotent within a room, so re-applying is safe.
    const resync = () => {
      trackerRef.current = new BattleTracker()
      fmtKeyRef.current = null  // force a format reload on the next render
      setPhase('waiting')
      window.psUI.getBuffer().then((buf) => {
        if (cancelled) return
        if (buf.frames.length) {
          for (const f of buf.frames) trackerRef.current.feed(f)
          console.log('[PSH ui] re-synced ' + buf.frames.length + ' buffered frames (room=' + buf.room + ')')
        }
        scheduleRender()
      }).catch((e) => { console.warn('[PSH ui] getBuffer failed during re-sync', e) })
    }
    resyncRef.current = resync

    // Auto re-sync once if frames keep arriving but nothing ever parses (init/request frames missed).
    const armStall = () => {
      if (stallTimerRef.current != null || autoResyncedRef.current) return
      stallTimerRef.current = window.setTimeout(() => {
        stallTimerRef.current = null
        if (cancelled || trackerRef.current.state.formatId || framesSeenRef.current === 0) return
        autoResyncedRef.current = true
        console.warn('[PSH ui] frames arrived but no battle parsed — auto re-syncing')
        resync()
      }, STALL_MS)
    }

    const onFrame = (payload: any) => {
      if (!payload || typeof payload.data !== 'string') return
      framesSeenRef.current++
      const prevRoom = trackerRef.current.state.roomid
      trackerRef.current.feed(payload.data)
      const curRoom = trackerRef.current.state.roomid
      // New battle: the tracker auto-reset on the new roomid. Pull that room's buffer so any early
      // frames we missed before this one are applied too.
      if (prevRoom && curRoom && curRoom !== prevRoom) {
        autoResyncedRef.current = false
        resync()
        return
      }
      scheduleRender()
      armStall()
    }

    // Register the live listener FIRST so no frame arriving during the async replay below is lost,
    // then replay the buffer to recover the once-only |init|/|request| frames that may have been
    // emitted before this component mounted.
    window.psUI.onFrame(onFrame)
    window.psUI.getBuffer().then((buf) => {
      if (cancelled || !buf.frames.length) return
      for (const f of buf.frames) trackerRef.current.feed(f)
      console.log('[PSH ui] replayed ' + buf.frames.length + ' buffered frames on mount (room=' + buf.room + ')')
      scheduleRender()
    }).catch((e) => { console.warn('[PSH ui] getBuffer failed on mount', e) })

    // Subscribe to transport health (tap / page / saveLogs) for the status line, and pull the current
    // snapshot in case the tap or page events fired before this listener registered.
    const unsubStatus = window.psUI.onStatus((s) => { if (!cancelled) setTransport(s) })
    window.psUI.getStatus().then((s) => { if (!cancelled) setTransport(s) })
      .catch((e) => { console.warn('[PSH ui] getStatus failed', e) })

    // Load core data once, then render the waiting state and start taking frames. A failure here used
    // to be an unhandled rejection that left the panel stuck silently — now it surfaces as an error.
    loadCore().then((c) => {
      if (cancelled) return
      coreRef.current = c
      scheduleRender()
    }).catch((e) => {
      if (cancelled) return
      setDataError(true)
      console.error('[PSH ui] core data failed to load', e)
    })

    return () => {
      cancelled = true
      clearStall()
      window.psUI.offFrame()
      unsubStatus()
    }
  }, [])

  // Manual re-sync from the header button (App bumps resyncSignal on click).
  useEffect(() => {
    if (resyncSignal > 0) resyncRef.current()
  }, [resyncSignal])

  const status = deriveStatus(transport, phase, dataError)

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div className="ps-helper">
        <div className={`ps-status ps-status--${status.tone}`}>
          <span className="ps-status__dot" />
          <span className="ps-status__text">{status.text}</span>
          {status.reload && (
            <button className="ps-status__reload" onClick={() => window.psUI.reloadPS()}>
              Reload
            </button>
          )}
        </div>
        <div className="ps-format">{format}</div>
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  )
}
