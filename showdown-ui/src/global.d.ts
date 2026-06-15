export {}

export interface PsStatus {
  tap: 'unknown' | 'ok' | 'error'
  page: 'ok' | 'unreachable'
  saveLogs: boolean
  logWrite: 'ok' | 'error'
}

declare global {
  interface Window {
    psUI: {
      version: string
      onFrame: (cb: (payload: { data: string }) => void) => void
      offFrame: () => void
      getBuffer: () => Promise<{ frames: string[]; room: string | null }>
      setGameBounds: (rect: { x: number; y: number; width: number; height: number }) => void
      beginResize: () => void
      endResize:   () => void
      onResizeDrag:    (cb: (x: number) => void) => () => void
      onResizeDragEnd: (cb: () => void) => () => void
      openExternal: (url: string) => void
      openLogs:     () => void
      getStatus: () => Promise<PsStatus>
      onStatus:  (cb: (s: PsStatus) => void) => () => void
      reloadPS:  () => void
      getAppConfig: () => Promise<{ checkUpdatesOnBoot: boolean }>
      checkUpdate: () => Promise<{ packaged?: boolean; upToDate?: boolean; ahead?: { ps: number; client: number }; error?: string }>
      applyUpdate: () => Promise<{ success: boolean; testOutput: string }>
      rollback: () => Promise<{ success: boolean }>
      skipUpdate: () => void
      onUpdateProgress: (cb: (step: string) => void) => () => void
    }
  }
}
