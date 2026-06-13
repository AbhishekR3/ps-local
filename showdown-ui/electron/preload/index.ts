import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('psUI', {
  version: '0.1.0',

  onFrame: (cb: (payload: { data: string }) => void) => {
    ipcRenderer.on('ps-frame', (_event, payload) => cb(payload))
  },

  offFrame: () => {
    ipcRenderer.removeAllListeners('ps-frame')
  },

  setGameBounds: (rect: { x: number; y: number; width: number; height: number }) => {
    ipcRenderer.send('set-game-bounds', rect)
  },

  beginResize: () => ipcRenderer.send('begin-resize'),
  endResize:   () => ipcRenderer.send('end-resize'),

  // Called when the mouse is over the PS view during a drag; main relays the
  // cursor x from the psView preload so the renderer can update helperWidth
  // without hiding the view. Returns an unsubscribe function.
  onResizeDrag: (cb: (x: number) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, { x }: { x: number }) => cb(x)
    ipcRenderer.on('resize-drag', handler)
    return () => ipcRenderer.removeListener('resize-drag', handler)
  },

  // Fired by main when mouseup was caught in the PS view (not the renderer).
  onResizeDragEnd: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on('resize-drag-end', handler)
    return () => ipcRenderer.removeListener('resize-drag-end', handler)
  },

  // Header actions: open the project repo in the system browser, or the battle-log folder in Finder.
  openExternal: (url: string) => ipcRenderer.send('open-external', url),
  openLogs:     () => ipcRenderer.send('open-logs'),
})
