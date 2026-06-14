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

const EMPTY_FMT: FormatData = { sets: null, items: null, abilities: null, teras: null, stats: null, movesFreq: null }

export default function HelperPanel() {
  const trackerRef = useRef<any>(null)
  if (!trackerRef.current) trackerRef.current = new BattleTracker()

  const coreRef = useRef<Core | null>(null)
  const fmtRef = useRef<FormatData>(EMPTY_FMT)
  const fmtKeyRef = useRef<string | null>(null)
  const rafRef = useRef(false)

  const [format, setFormat] = useState('Waiting for a battle…')
  const [html, setHtml] = useState(waitingHtml())

  useEffect(() => {
    let cancelled = false

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
      await ensureFormat()
      if (cancelled) return
      const res = renderBattle(trackerRef.current.state, coreRef.current, fmtRef.current)
      setFormat(res.format)
      setHtml(res.html)
    }

    // Coalesce bursts of frames into one render per animation frame.
    const scheduleRender = () => {
      if (rafRef.current) return
      rafRef.current = true
      requestAnimationFrame(doRender)
    }

    const onFrame = (payload: any) => {
      if (!payload || typeof payload.data !== 'string') return
      trackerRef.current.feed(payload.data)
      scheduleRender()
    }

    // Register the live listener FIRST so no frame arriving during the async replay below is lost,
    // then replay the buffer. feed() is idempotent within a room, so re-applying buffered frames
    // after a live one just rebuilds the same state — the point is to recover the once-only
    // |init|/|request| frames that may have been emitted before this component mounted.
    window.psUI.onFrame(onFrame)
    window.psUI.getBuffer?.().then((buf) => {
      if (cancelled || !buf?.frames?.length) return
      for (const f of buf.frames) trackerRef.current.feed(f)
      console.log('[PSH ui] replayed ' + buf.frames.length + ' buffered frames on mount (room=' + buf.room + ')')
      scheduleRender()
    }).catch(() => {})

    // Load core data once, then render the waiting state and start taking frames.
    loadCore().then((c) => {
      if (cancelled) return
      coreRef.current = c
      scheduleRender()
    })

    return () => {
      cancelled = true
      window.psUI.offFrame()
    }
  }, [])

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div className="ps-helper">
        <div className="ps-format">{format}</div>
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  )
}
