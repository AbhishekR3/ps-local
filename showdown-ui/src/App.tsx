import { useEffect, useState } from 'react'
import './styles/global.css'
import Battle from './routes/Battle'
import UpdateScreen from './components/UpdateScreen'

const REPO_URL = 'https://github.com/AbhishekR3/ps-local'

type BootState = 'loading' | 'update' | 'ready'

export default function App() {
  const [bootState, setBootState] = useState<BootState>('loading')

  useEffect(() => {
    window.psUI.getAppConfig()
      .then(cfg => setBootState(cfg.checkUpdatesOnBoot ? 'update' : 'ready'))
      .catch(() => setBootState('ready'))
  }, [])

  // Owns the helper-open state so the toggle can live in this header (always above the psView, which
  // would occlude a button placed over the game region). Battle reads it to collapse the panel.
  const [helperOpen, setHelperOpen] = useState(true)
  // Bumped on each Re-sync click; HelperPanel rebuilds its tracker from the frame buffer when it
  // changes. Lives here so the button stays in the always-visible header (works even when collapsed).
  const [resyncSignal, setResyncSignal] = useState(0)

  if (bootState === 'loading') return null
  if (bootState === 'update') return <UpdateScreen onDone={() => setBootState('ready')} />

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
          <button
            className="header-btn"
            title="Rebuild the battle helper from the current battle (use if it's stuck or out of sync)"
            onClick={() => setResyncSignal((n) => n + 1)}
          >
            Re-sync ↻
          </button>
          <button className="header-btn" title="Open the battle-log folder" onClick={() => window.psUI.openLogs()}>
            Open Logs ↗
          </button>
          <button className="header-btn" title="View this project on GitHub" onClick={() => window.psUI.openExternal(REPO_URL)}>
            GitHub ↗
          </button>
          <button
            className="header-btn"
            title={helperOpen ? 'Hide the battle helper' : 'Show the battle helper'}
            onClick={() => setHelperOpen((o) => !o)}
          >
            {helperOpen ? '⟩ Hide Helper' : '⟨ Show Helper'}
          </button>
        </div>
      </header>

      {/* ── Main area (game + helper) ────────────────────────────── */}
      <Battle helperOpen={helperOpen} resyncSignal={resyncSignal} />

    </div>
  )
}
