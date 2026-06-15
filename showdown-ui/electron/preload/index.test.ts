import { describe, it, expect, vi, beforeEach } from 'vitest'

// The preload wires the renderer's window.psUI API onto IPC. The guards.test.js endpoint-map check
// proves the channel *names* exist on both sides; this test proves each psUI method actually invokes
// the channel it claims to (a behavioral complement — a method calling the wrong channel name passes
// the text guard but fails here).

const invoke = vi.fn()
const send = vi.fn()
const on = vi.fn()
const removeListener = vi.fn()
const removeAllListeners = vi.fn()

// Capture the object the preload exposes so we can call its methods.
let psUI: Record<string, (...args: unknown[]) => unknown>

vi.mock('electron', () => ({
  ipcRenderer: { invoke, send, on, removeListener, removeAllListeners },
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Record<string, (...args: unknown[]) => unknown>) => {
      psUI = api
    },
  },
}))

beforeEach(async () => {
  vi.clearAllMocks()
  vi.resetModules()
  await import('./index')
})

describe('preload psUI → IPC channel mapping', () => {
  it('routes invoke-style methods to the correct channels', () => {
    psUI.getBuffer()
    psUI.getStatus()
    psUI.getAppConfig()
    psUI.checkUpdate()
    psUI.applyUpdate()
    psUI.rollback()
    const channels = invoke.mock.calls.map((c) => c[0])
    expect(channels).toEqual([
      'get-buffer', 'get-status', 'get-app-config', 'update-check', 'update-apply', 'update-rollback',
    ])
  })

  it('routes send-style methods to the correct channels', () => {
    psUI.setGameBounds({ x: 0, y: 0, width: 1, height: 1 })
    psUI.beginResize()
    psUI.endResize()
    psUI.openExternal('https://example.com')
    psUI.openLogs()
    psUI.reloadPS()
    const channels = send.mock.calls.map((c) => c[0])
    expect(channels).toEqual([
      'set-game-bounds', 'begin-resize', 'end-resize', 'open-external', 'open-logs', 'reload-ps',
    ])
  })

  it('subscribes update progress on the update-apply-progress channel and unsubscribes cleanly', () => {
    const cb = vi.fn()
    const unsub = psUI.onUpdateProgress(cb) as () => void
    expect(on.mock.calls.some((c) => c[0] === 'update-apply-progress')).toBe(true)
    unsub()
    expect(removeListener.mock.calls.some((c) => c[0] === 'update-apply-progress')).toBe(true)
  })
})
