import { Notification } from 'electron'

export interface TimerState { timerNotified: boolean }

function showOsNotif(title: string, body: string, isFocused: () => boolean): void {
  if (!Notification.isSupported()) return
  if (isFocused()) return
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

function notifyMove(parts: string[], mySide: string, isFocused: () => boolean): void {
  if (parts.length < 4) return
  const sideMatch = /^(p\d)/.exec(parts[2])
  if (sideMatch === null || sideMatch[1] === mySide) return
  const poke = parts[2].split(': ')[1] || parts[2]
  showOsNotif('Pokémon Showdown', `${poke} used ${parts[3]}!`, isFocused)
}

function notifyTimer(state: TimerState, msg: string, isFocused: () => boolean): void {
  if (state.timerNotified || msg === '') return
  if (!isUrgentTimer(msg)) return
  state.timerNotified = true
  showOsNotif('Pokémon Showdown — Timer!', msg, isFocused)
}

export function maybeNotify(
  mySide: string | null,
  frameData: string,
  state: TimerState,
  isFocused: () => boolean
): void {
  if (mySide === null) return
  for (const line of frameData.split('\n')) {
    if (!line.startsWith('|')) continue
    const parts = line.split('|')
    const cmd = parts[1]
    if (cmd === 'move') notifyMove(parts, mySide, isFocused)
    else if (cmd === 'inactive') notifyTimer(state, parts[2], isFocused)
  }
}
