import { useEffect, useRef, useState } from 'react'

const RELEASES_URL = 'https://github.com/AbhishekR3/ps-local/releases'

type Phase =
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'update-available'; ps: number; client: number }
  | { kind: 'applying'; lines: string[] }
  | { kind: 'result-success' }
  | { kind: 'result-fail'; lines: string[] }
  | { kind: 'packaged-update' }
  | { kind: 'error'; message: string }

export default function UpdateScreen({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' })
  // Ref so the progress handler closure always appends to the latest lines array.
  const linesRef = useRef<string[]>([])

  useEffect(() => {
    window.psUI.checkUpdate().then(res => {
      if (res.packaged) {
        setPhase({ kind: 'packaged-update' })
      } else if (res.error) {
        setPhase({ kind: 'error', message: res.error })
      } else if (res.upToDate) {
        setPhase({ kind: 'up-to-date' })
      } else {
        setPhase({ kind: 'update-available', ps: res.ahead?.ps ?? 0, client: res.ahead?.client ?? 0 })
      }
    }).catch((e: unknown) => {
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    })
  }, [])

  function handleApply() {
    linesRef.current = []
    setPhase({ kind: 'applying', lines: [] })

    const unsub = window.psUI.onUpdateProgress(step => {
      linesRef.current = [...linesRef.current, step]
      setPhase({ kind: 'applying', lines: linesRef.current })
    })

    window.psUI.applyUpdate().then(res => {
      unsub()
      if (res.success) {
        setPhase({ kind: 'result-success' })
      } else {
        setPhase({ kind: 'result-fail', lines: linesRef.current })
      }
    }).catch((e: unknown) => {
      unsub()
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    })
  }

  function handleRollback() {
    window.psUI.rollback().then(() => onDone())
  }

  const wrap: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    height: '100%', gap: 16, padding: 32, background: 'var(--bg)', color: 'var(--text)',
    fontFamily: 'inherit',
  }
  const card: React.CSSProperties = {
    background: 'var(--bg-header)', border: '1px solid var(--border)', borderRadius: 8,
    padding: '24px 32px', maxWidth: 540, width: '100%', display: 'flex', flexDirection: 'column', gap: 12,
  }
  const title: React.CSSProperties = { fontWeight: 700, fontSize: 15, marginBottom: 4 }
  const sub: React.CSSProperties = { fontSize: 13, color: 'var(--text-dim, #aaa)', lineHeight: 1.5 }
  const btnRow: React.CSSProperties = { display: 'flex', gap: 8, marginTop: 8 }
  const log: React.CSSProperties = {
    background: '#111', border: '1px solid var(--border)', borderRadius: 4, padding: 10,
    fontSize: 11, fontFamily: 'monospace', maxHeight: 260, overflowY: 'auto',
    whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#ccc',
  }

  function Btn({ onClick, primary, children }: { onClick: () => void; primary?: boolean; children: React.ReactNode }) {
    return (
      <button
        className="header-btn"
        onClick={onClick}
        style={primary ? { background: 'var(--accent, #4a7dff)', color: '#fff', fontWeight: 600 } : {}}
      >
        {children}
      </button>
    )
  }

  if (phase.kind === 'checking') {
    return (
      <div style={wrap}>
        <div style={card}>
          <div style={title}>Checking for upstream updates…</div>
          <div style={sub}>Fetching latest commits from Pokémon Showdown repositories.</div>
        </div>
      </div>
    )
  }

  if (phase.kind === 'packaged-update') {
    return (
      <div style={wrap}>
        <div style={card}>
          <div style={title}>Update available</div>
          <div style={sub}>
            A new version of ps-local may be available. Download the latest installer from GitHub Releases.
          </div>
          <div style={btnRow}>
            <Btn primary onClick={() => window.psUI.openExternal(RELEASES_URL)}>Open Releases ↗</Btn>
            <Btn onClick={onDone}>Continue anyway</Btn>
          </div>
        </div>
      </div>
    )
  }

  if (phase.kind === 'error') {
    return (
      <div style={wrap}>
        <div style={card}>
          <div style={title}>Update check failed</div>
          <div style={{ ...sub, color: 'var(--warn, #e87b3a)' }}>{phase.message}</div>
          <div style={btnRow}><Btn primary onClick={onDone}>Skip for now</Btn></div>
        </div>
      </div>
    )
  }

  if (phase.kind === 'up-to-date') {
    return (
      <div style={wrap}>
        <div style={card}>
          <div style={title}>Everything is up to date</div>
          <div style={sub}>Both Pokémon Showdown submodules are at the latest upstream commit.</div>
          <div style={btnRow}><Btn primary onClick={onDone}>Continue</Btn></div>
        </div>
      </div>
    )
  }

  if (phase.kind === 'update-available') {
    const parts = []
    if (phase.ps > 0)     parts.push(`${phase.ps} new commit${phase.ps > 1 ? 's' : ''} in pokemon-showdown`)
    if (phase.client > 0) parts.push(`${phase.client} new commit${phase.client > 1 ? 's' : ''} in pokemon-showdown-client`)
    return (
      <div style={wrap}>
        <div style={card}>
          <div style={title}>Upstream updates available</div>
          <div style={sub}>{parts.join('; ')}.</div>
          <div style={{ ...sub, marginTop: 4 }}>
            "Update &amp; verify" pulls the new commits and runs the helper test suite.
            If tests fail you can roll back to the current state.
          </div>
          <div style={btnRow}>
            <Btn primary onClick={handleApply}>Update &amp; verify</Btn>
            <Btn onClick={onDone}>Skip for now</Btn>
          </div>
        </div>
      </div>
    )
  }

  if (phase.kind === 'applying') {
    const text = phase.lines.join('')
    return (
      <div style={wrap}>
        <div style={{ ...card, maxWidth: 680 }}>
          <div style={title}>Applying update…</div>
          <div style={sub}>Do not close the app. This may take a minute.</div>
          <div style={log}>{text || 'Starting…'}</div>
        </div>
      </div>
    )
  }

  if (phase.kind === 'result-success') {
    return (
      <div style={wrap}>
        <div style={card}>
          <div style={title}>Update applied and verified</div>
          <div style={sub}>All helper tests passed against the new upstream commits.</div>
          <div style={btnRow}><Btn primary onClick={onDone}>Continue</Btn></div>
        </div>
      </div>
    )
  }

  // result-fail
  const failLines = phase.kind === 'result-fail' ? phase.lines.join('') : ''
  // Show last 50 lines of output to keep the log readable.
  const truncated = failLines.split('\n').slice(-50).join('\n')
  return (
    <div style={wrap}>
      <div style={{ ...card, maxWidth: 680 }}>
        <div style={{ ...title, color: 'var(--warn, #e87b3a)' }}>Update applied — tests failed</div>
        <div style={sub}>
          The helper test suite failed after the upstream pull. Roll back to restore the prior submodule state,
          or keep the update and investigate manually.
        </div>
        <div style={log}>{truncated}</div>
        <div style={btnRow}>
          <Btn primary onClick={handleRollback}>Roll back</Btn>
          <Btn onClick={onDone}>Keep &amp; continue</Btn>
        </div>
      </div>
    </div>
  )
}
