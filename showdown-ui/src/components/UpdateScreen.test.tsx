import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import UpdateScreen from './UpdateScreen'

// UpdateScreen is the on-boot update state machine. Its only inputs are the window.psUI IPC methods,
// so we mock them per-test and assert the rendered phase. This covers the boot branch logic
// (checkUpdate → packaged / error / up-to-date / update-available) and the apply path
// (applying → result-success | result-fail → rollback), which the text-level guard in guards.test.js
// cannot reach (that one only proves every phase has *some* branch, not that the transitions are right).

// Minimal psUI stub — only the members UpdateScreen touches. Cast through unknown so we don't have to
// stub the entire (frame/resize/status) surface the real preload exposes.
type PsUIMock = {
  checkUpdate: ReturnType<typeof vi.fn>
  applyUpdate: ReturnType<typeof vi.fn>
  rollback: ReturnType<typeof vi.fn>
  onUpdateProgress: ReturnType<typeof vi.fn>
  openExternal: ReturnType<typeof vi.fn>
}

let psUI: PsUIMock
let onDone: ReturnType<typeof vi.fn>

beforeEach(() => {
  onDone = vi.fn()
  psUI = {
    checkUpdate: vi.fn(),
    applyUpdate: vi.fn(),
    rollback: vi.fn(),
    // onUpdateProgress returns an unsubscribe fn; default no-op.
    onUpdateProgress: vi.fn().mockReturnValue(() => {}),
    openExternal: vi.fn(),
  }
  ;(window as unknown as { psUI: PsUIMock }).psUI = psUI
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('UpdateScreen boot check', () => {
  it('shows the packaged → GitHub Releases branch when running packaged', async () => {
    psUI.checkUpdate.mockResolvedValue({ packaged: true })
    render(<UpdateScreen onDone={onDone} />)
    expect(await screen.findByText(/Open Releases/i)).toBeTruthy()
    await userEvent.click(screen.getByText(/Open Releases/i))
    expect(psUI.openExternal).toHaveBeenCalledWith(expect.stringContaining('/releases'))
  })

  it('shows up-to-date when both submodules are current', async () => {
    psUI.checkUpdate.mockResolvedValue({ upToDate: true })
    render(<UpdateScreen onDone={onDone} />)
    expect(await screen.findByText(/up to date/i)).toBeTruthy()
  })

  it('shows the error branch when checkUpdate returns an error', async () => {
    psUI.checkUpdate.mockResolvedValue({ error: 'fetch failed' })
    render(<UpdateScreen onDone={onDone} />)
    expect(await screen.findByText(/fetch failed/)).toBeTruthy()
  })

  it('shows the error branch when checkUpdate rejects', async () => {
    psUI.checkUpdate.mockRejectedValue(new Error('boom'))
    render(<UpdateScreen onDone={onDone} />)
    expect(await screen.findByText(/boom/)).toBeTruthy()
  })

  it('renders both commit counts when updates are available', async () => {
    psUI.checkUpdate.mockResolvedValue({ ahead: { ps: 3, client: 2 } })
    render(<UpdateScreen onDone={onDone} />)
    // The counts render in one ".sub" line; match the exact composed string (the description paragraph
    // also contains "new commits", so a loose /new commit/ regex hits multiple nodes).
    expect(await screen.findByText(/3 new commits in pokemon-showdown; 2 new commits in pokemon-showdown-client/i)).toBeTruthy()
  })
})

describe('UpdateScreen apply flow', () => {
  it('drives update-available → applying → result-success', async () => {
    psUI.checkUpdate.mockResolvedValue({ ahead: { ps: 1, client: 0 } })
    psUI.applyUpdate.mockResolvedValue({ success: true, testOutput: 'ok' })
    render(<UpdateScreen onDone={onDone} />)

    await userEvent.click(await screen.findByRole("button", { name: /Update & verify/i }))
    expect(await screen.findByText(/applied and verified/i)).toBeTruthy()
    expect(psUI.applyUpdate).toHaveBeenCalledOnce()
  })

  it('shows result-fail with a working rollback on test failure', async () => {
    psUI.checkUpdate.mockResolvedValue({ ahead: { ps: 1, client: 0 } })
    psUI.applyUpdate.mockResolvedValue({ success: false, testOutput: 'tests failed' })
    psUI.rollback.mockResolvedValue({ success: true })
    render(<UpdateScreen onDone={onDone} />)

    await userEvent.click(await screen.findByRole("button", { name: /Update & verify/i }))
    expect(await screen.findByText(/tests failed/i)).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: /Roll back/i }))
    await waitFor(() => expect(psUI.rollback).toHaveBeenCalledOnce())
    // A successful rollback closes the screen via onDone.
    await waitFor(() => expect(onDone).toHaveBeenCalled())
  })

  it('surfaces a failed rollback as an error', async () => {
    psUI.checkUpdate.mockResolvedValue({ ahead: { ps: 1, client: 0 } })
    psUI.applyUpdate.mockResolvedValue({ success: false, testOutput: 'tests failed' })
    psUI.rollback.mockResolvedValue({ success: false })
    render(<UpdateScreen onDone={onDone} />)

    await userEvent.click(await screen.findByRole("button", { name: /Update & verify/i }))
    await userEvent.click(await screen.findByRole('button', { name: /Roll back/i }))
    expect(await screen.findByText(/Rollback failed/i)).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
  })
})
