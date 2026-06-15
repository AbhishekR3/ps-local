import type { CSSProperties } from 'react'
import { useEffect, useRef, useState, useCallback } from 'react'
import HelperPanel from '../components/HelperPanel'

const MIN_HELPER = 280
const MAX_HELPER = 720
const clampHelper = (w: number) => Math.max(MIN_HELPER, Math.min(MAX_HELPER, w))

const colHeader: CSSProperties = {
  padding: '10px 14px',
  background: 'var(--bg-panel)',
  borderBottom: '1px solid var(--border)',
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.07em',
  color: 'var(--muted)',
  flexShrink: 0,
}

export default function Battle({ helperOpen, resyncSignal }: { helperOpen: boolean; resyncSignal: number }) {
  const gameRef        = useRef<HTMLDivElement>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const [helperWidth, setHelperWidth] = useState(() => clampHelper(window.innerWidth - 895))

  // Report the game container's rect to main so the embedded PS client (a
  // WebContentsView overlay) fills exactly this region, tracking resizes.
  const report = useCallback(() => {
    const el = gameRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    window.psUI.setGameBounds({ x: r.x, y: r.y, width: r.width, height: r.height })
  }, [])

  useEffect(() => {
    const el = gameRef.current
    if (!el) return
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    window.addEventListener('resize', report)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [report])

  // Collapsing/expanding the helper resizes the game region. Re-report psView bounds after React
  // commits the new width (rAF waits for layout) so the embedded client tracks it precisely.
  useEffect(() => { requestAnimationFrame(report) }, [helperOpen, report])

  // When the mouse is over the psView during a drag, the renderer doesn't get
  // mousemove/mouseup — the psView preload relays them through main instead.
  // onResizeDrag covers position updates; onResizeDragEnd triggers cleanup so
  // the renderer-side listeners are always removed even on mouseup in the psView.
  useEffect(() => {
    const unsubMove = window.psUI.onResizeDrag((x) => {
      setHelperWidth(clampHelper(window.innerWidth - x))
    })
    const unsubEnd = window.psUI.onResizeDragEnd(() => {
      dragCleanupRef.current?.()
    })
    return () => { unsubMove(); unsubEnd() }
  }, [report])

  // Drag the divider to resize the helper panel. beginResize asks the psView
  // preload to start relaying events so the view stays visible throughout.
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    window.psUI.beginResize()

    const onMove = (ev: MouseEvent) => {
      setHelperWidth(clampHelper(window.innerWidth - ev.clientX))
    }
    const doCleanup = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      dragCleanupRef.current = null
      window.psUI.endResize()
      requestAnimationFrame(report)
    }
    const onUp = () => doCleanup()
    dragCleanupRef.current = doCleanup
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>

      {/* ── Left: embedded live PS client (overlaid by WebContentsView) ──── */}
      <div
        ref={gameRef}
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--subtle)',
          fontSize: 13,
          fontStyle: 'italic',
          background: 'var(--bg-base)',
        }}
      >
        Loading Pokémon Showdown…
      </div>

      {/* ── Divider: drag to resize the helper panel (hidden when collapsed) ── */}
      <div
        onMouseDown={startDrag}
        style={{
          width: 6,
          flexShrink: 0,
          cursor: 'col-resize',
          background: 'var(--border)',
          display: helperOpen ? 'block' : 'none',
        }}
      />

      {/* ── Right: battle helper (collapses to width 0; HelperPanel stays mounted
             so its BattleTracker state survives a hide/show) ─────────────────── */}
      <div style={{
        width: helperOpen ? helperWidth : 0,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-card)',
        overflow: 'hidden',
      }}>
        <div style={colHeader}>Battle Helper</div>
        <HelperPanel resyncSignal={resyncSignal} />
      </div>

    </div>
  )
}
