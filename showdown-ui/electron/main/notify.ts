import { Notification, BrowserWindow } from 'electron'

export interface TimerState { timerNotified: boolean }

function showOsNotif(title: string, body: string, win: BrowserWindow | null): void {
  if (!Notification.isSupported()) return
  if (win !== null && win.isFocused()) return
  const notif = new Notification({ title, body })
  notif.show()
}

function urgentTimerSeconds(msg: string): number {
  const secM = /(\d+)\s*second/i.exec(msg)
  const minM = /(\d+)\s*minute/i.exec(msg)
  let total = 0
  if (secM !== null) total = parseInt(secM[1], 10)
  if (minM !== null) total = total + parseInt(minM[1], 10) * 60
  return total
}

function isUrgentTimer(msg: string): boolean {
  const t = urgentTimerSeconds(msg)
  return t > 0 && t <= 60
}

function notifyMove(parts: string[], mySide: string, win: BrowserWindow | null): void {
  if (parts[2] === undefined || parts[3] === undefined) return
  const sideMatch = /^(p\d)/.exec(parts[2])
  if (sideMatch === null || sideMatch[1] === mySide) return
  const poke = parts[2].split(': ')[1] || parts[2]
  showOsNotif('Pokémon Showdown', `${poke} used ${parts[3]}!`, win)
}

function notifyTimer(state: TimerState, msg: string, win: BrowserWindow | null): void {
  if (state.timerNotified || msg === '') return
  if (!isUrgentTimer(msg)) return
  state.timerNotified = true
  showOsNotif('Pokémon Showdown — Timer!', msg, win)
}

export function maybeNotify(
  mySide: string | null,
  frameData: string,
  state: TimerState,
  win: BrowserWindow | null
): void {
  if (mySide === null) return
  for (const line of frameData.split('\n')) {
    if (!line.startsWith('|')) continue
    const parts = line.split('|')
    const cmd = parts[1]
    if (cmd === 'move') notifyMove(parts, mySide, win)
    else if (cmd === 'inactive') notifyTimer(state, parts[2], win)
  }
}
