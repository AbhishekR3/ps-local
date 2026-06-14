import type { CSSProperties } from 'react'
import { useState } from 'react'
import './styles/global.css'
import Battle from './routes/Battle'

const REPO_URL = 'https://github.com/AbhishekR3/ps-local'

const headerBtn: CSSProperties = {
  background: 'none',
  border: '1px solid var(--border)',
  borderRadius: 4,
  cursor: 'pointer',
  color: 'var(--muted)',
  fontSize: 11,
  padding: '3px 8px',
  lineHeight: 1.4,
}

export default function App() {
  // Owns the helper-open state so the toggle can live in this header (always above the psView, which
  // would occlude a button placed over the game region). Battle reads it to collapse the panel.
  const [helperOpen, setHelperOpen] = useState(true)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>

      {/* ── Top header bar ───────────────────────────────────────── */}
      <header style={{
        height: 40,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 16px',
        background: 'var(--bg-header)',
        borderBottom: '1px solid var(--border)',
      }}>
        <span style={{ fontWeight: 700, color: 'var(--text)', fontSize: 14, letterSpacing: '0.02em' }}>
          Pokemon Showdown Battle UI
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button style={headerBtn} title="Open the battle-log folder" onClick={() => window.psUI.openLogs()}>
            Open Logs ↗
          </button>
          <button style={headerBtn} title="View this project on GitHub" onClick={() => window.psUI.openExternal(REPO_URL)}>
            GitHub ↗
          </button>
          <button
            style={headerBtn}
            title={helperOpen ? 'Hide the battle helper' : 'Show the battle helper'}
            onClick={() => setHelperOpen((o) => !o)}
          >
            {helperOpen ? '⟩ Hide Helper' : '⟨ Show Helper'}
          </button>
        </div>
      </header>

      {/* ── Main area (game + helper) ────────────────────────────── */}
      <Battle helperOpen={helperOpen} />

    </div>
  )
}
