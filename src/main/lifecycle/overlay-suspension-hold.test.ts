import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { holdAppSuspensionWhileVisible, type SuspensionBlocker, type SuspensionHoldWindow } from './overlay-suspension-hold'

function fakeBlocker(): SuspensionBlocker & { active: Set<number>; starts: string[] } {
  const active = new Set<number>()
  const starts: string[] = []
  let next = 1
  return {
    active,
    starts,
    start(type) {
      starts.push(type)
      const id = next++
      active.add(id)
      return id
    },
    stop(id) {
      active.delete(id)
    },
    isStarted(id) {
      return active.has(id)
    }
  }
}

function fakeWindow(visible = false): EventEmitter & SuspensionHoldWindow & { show(): void; hide(): void; close(): void } {
  const win = new EventEmitter() as EventEmitter & SuspensionHoldWindow & { show(): void; hide(): void; close(): void }
  let shown = visible
  let destroyed = false
  win.isDestroyed = () => destroyed
  win.isVisible = () => shown
  win.show = () => {
    shown = true
    win.emit('show')
  }
  win.hide = () => {
    shown = false
    win.emit('hide')
  }
  win.close = () => {
    shown = false
    destroyed = true
    win.emit('closed')
  }
  return win
}

describe('holdAppSuspensionWhileVisible (M2-0518)', () => {
  it('holds prevent-app-suspension from the first show until the overlay hides', () => {
    const blocker = fakeBlocker()
    const win = fakeWindow()
    holdAppSuspensionWhileVisible(win, blocker)
    expect(blocker.active.size).toBe(0)

    win.show()
    expect(blocker.starts).toEqual(['prevent-app-suspension'])
    expect(blocker.active.size).toBe(1)

    win.hide()
    expect(blocker.active.size).toBe(0)
  })

  it('holds at once for an already visible overlay, and re-holds after a hide and show', () => {
    const blocker = fakeBlocker()
    const win = fakeWindow(true)
    holdAppSuspensionWhileVisible(win, blocker)
    expect(blocker.active.size).toBe(1)

    win.hide()
    win.show()
    expect(blocker.starts).toHaveLength(2)
    expect(blocker.active.size).toBe(1)
  })

  it('never starts a second blocker for a repeated show', () => {
    const blocker = fakeBlocker()
    const win = fakeWindow()
    holdAppSuspensionWhileVisible(win, blocker)
    win.show()
    win.show()
    expect(blocker.starts).toHaveLength(1)
  })

  it('releases the hold when the overlay closes, leaving other blockers alone', () => {
    const blocker = fakeBlocker()
    const meeting = blocker.start('prevent-app-suspension')
    const win = fakeWindow(true)
    holdAppSuspensionWhileVisible(win, blocker)
    expect(blocker.active.size).toBe(2)

    win.close()
    expect([...blocker.active]).toEqual([meeting])
  })
})
