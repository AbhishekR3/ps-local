export {}

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
    }
  }
}
