import { useEffect, useRef, useState } from 'react'

const REPO_URL     = 'https://github.com/AbhishekR3/ps-local'
const RELEASES_URL = `${REPO_URL}/releases`

type Phase =
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'update-available'; ps: number; client: number }
  | { kind: 'applying' }
  | { kind: 'result-success' }
  | { kind: 'result-fail'; text: string }
  | { kind: 'packaged-update' }
  | { kind: 'error'; message: string }

// ── Shared styles (module-level — not reconstructed on every render) ──────────
const S = {
  wrap: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    height: '100%', gap: 16, padding: 32, background: 'var(--bg)', color: 'var(--text)',
    fontFamily: 'inherit',
  } as React.CSSProperties,
  card: {
    background: 'var(--bg-header)', border: '1px solid var(--border)', borderRadius: 8,
    padding: '24px 32px', maxWidth: 540, width: '100%', display: 'flex', flexDirection: 'column', gap: 12,
  } as React.CSSProperties,
  // cardWide inherits all card properties; only maxWidth differs.
  get cardWide() { return { ...this.card, maxWidth: 680 } as React.CSSProperties },
  title: { fontWeight: 700, fontSize: 15, marginBottom: 4 } as React.CSSProperties,
  get titleWarn() { return { ...this.title, color: 'var(--warn, #e87b3a)' } as React.CSSProperties },
  sub: { fontSize: 13, color: 'var(--text-dim, #aaa)', lineHeight: 1.5 } as React.CSSProperties,
  get subWarn() { return { ...this.sub, color: 'var(--warn, #e87b3a)' } as React.CSSProperties },
  btnRow: { display: 'flex', gap: 8, marginTop: 8 } as React.CSSProperties,
  log: {
    background: '#111', border: '1px solid var(--border)', borderRadius: 4, padding: 10,
    fontSize: 11, fontFamily: 'monospace', maxHeight: 260, overflowY: 'auto',
    whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#ccc',
  } as React.CSSProperties,
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

export default function UpdateScreen({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' })
  // Accumulate progress as a single string — no array copies on each incoming chunk.
  const logRef = useRef('')
  const [, forceRender] = useState(0)

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
    logRef.current = ''
    setPhase({ kind: 'applying' })

    const unsub = window.psUI.onUpdateProgress(step => {
      logRef.current += step
      forceRender(n => n + 1)
    })

    window.psUI.applyUpdate().then(res => {
      unsub()
      if (res.success) {
        setPhase({ kind: 'result-success' })
      } else {
        setPhase({ kind: 'result-fail', text: logRef.current })
      }
    }).catch((e: unknown) => {
      unsub()
      setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    })
  }

  function handleRollback() {
    void window.psUI.rollback().then(res => {
      if (!res.success) {
        setPhase({ kind: 'error', message: 'Rollback failed — submodules may be in a mixed state. Check vendor/ manually.' })
      } else {
        onDone()
      }
    }).catch((e: unknown) => {
      setPhase({ kind: 'error', message: `Rollback error: ${e instanceof Error ? e.message : String(e)}` })
    })
  }

  if (phase.kind === 'checking') {
    return (
      <div style={S.wrap}>
        <div style={S.card}>
          <div style={S.title}>Checking for upstream updates…</div>
          <div style={S.sub}>Fetching latest commits from Pokémon Showdown repositories.</div>
        </div>
      </div>
    )
  }

  if (phase.kind === 'packaged-update') {
    return (
      <div style={S.wrap}>
        <div style={S.card}>
          <div style={S.title}>Update available</div>
          <div style={S.sub}>
            A new version of ps-local may be available. Download the latest installer from GitHub Releases.
          </div>
          <div style={S.btnRow}>
            <Btn primary onClick={() => window.psUI.openExternal(RELEASES_URL)}>Open Releases ↗</Btn>
            <Btn onClick={onDone}>Continue anyway</Btn>
          </div>
        </div>
      </div>
    )
  }

  if (phase.kind === 'error') {
    return (
      <div style={S.wrap}>
        <div style={S.card}>
          <div style={S.title}>Update check failed</div>
          <div style={S.subWarn}>{phase.message}</div>
          <div style={S.btnRow}><Btn primary onClick={onDone}>Skip for now</Btn></div>
        </div>
      </div>
    )
  }

  if (phase.kind === 'up-to-date') {
    return (
      <div style={S.wrap}>
        <div style={S.card}>
          <div style={S.title}>Everything is up to date</div>
          <div style={S.sub}>Both Pokémon Showdown submodules are at the latest upstream commit.</div>
          <div style={S.btnRow}><Btn primary onClick={onDone}>Continue</Btn></div>
        </div>
      </div>
    )
  }

  if (phase.kind === 'update-available') {
    const parts = []
    if (phase.ps > 0)     parts.push(`${phase.ps} new commit${phase.ps > 1 ? 's' : ''} in pokemon-showdown`)
    if (phase.client > 0) parts.push(`${phase.client} new commit${phase.client > 1 ? 's' : ''} in pokemon-showdown-client`)
    return (
      <div style={S.wrap}>
        <div style={S.card}>
          <div style={S.title}>Upstream updates available</div>
          <div style={S.sub}>{parts.join('; ')}.</div>
          <div style={{ ...S.sub, marginTop: 4 }}>
            "Update &amp; verify" pulls the new commits and runs the helper test suite.
            If tests fail you can roll back to the current state.
          </div>
          <div style={S.btnRow}>
            <Btn primary onClick={handleApply}>Update &amp; verify</Btn>
            <Btn onClick={onDone}>Skip for now</Btn>
          </div>
        </div>
      </div>
    )
  }

  if (phase.kind === 'applying') {
    return (
      <div style={S.wrap}>
        <div style={S.cardWide}>
          <div style={S.title}>Applying update…</div>
          <div style={S.sub}>Do not close the app. This may take a minute.</div>
          <div style={S.log}>{logRef.current || 'Starting…'}</div>
        </div>
      </div>
    )
  }

  if (phase.kind === 'result-success') {
    return (
      <div style={S.wrap}>
        <div style={S.card}>
          <div style={S.title}>Update applied and verified</div>
          <div style={S.sub}>All helper tests passed against the new upstream commits.</div>
          <div style={S.btnRow}><Btn primary onClick={onDone}>Continue</Btn></div>
        </div>
      </div>
    )
  }

  // result-fail
  // Show last 50 lines of output to keep the log readable.
  const truncated = phase.text.split('\n').slice(-50).join('\n')
  return (
    <div style={S.wrap}>
      <div style={S.cardWide}>
        <div style={S.titleWarn}>Update applied — tests failed</div>
        <div style={S.sub}>
          The helper test suite failed after the upstream pull. Roll back to restore the prior submodule state,
          or keep the update and investigate manually.
        </div>
        <div style={S.log}>{truncated}</div>
        <div style={S.btnRow}>
          <Btn primary onClick={handleRollback}>Roll back</Btn>
          <Btn onClick={onDone}>Keep &amp; continue</Btn>
        </div>
      </div>
    </div>
  )
}
