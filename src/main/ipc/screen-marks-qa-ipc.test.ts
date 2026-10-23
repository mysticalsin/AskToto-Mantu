import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, raw?: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: (event: unknown, raw?: unknown) => unknown) => handlers.set(channel, fn) }
}))

import { qaScreenMarksEnabled, registerScreenMarksQaIpc } from './screen-marks-qa-ipc'

describe('QA mark placement IPC (G43)', () => {
  const place = vi.fn(() => ({ ok: true as const, markId: 'm1' }))
  const clear = vi.fn()
  const assertMainWindow = vi.fn()
  beforeEach(() => {
    handlers.clear()
    place.mockClear()
    clear.mockClear()
    assertMainWindow.mockReset()
    registerScreenMarksQaIpc(assertMainWindow, { place, clear })
  })

  it('checks the sender, validates the input and places on the named screenshot', () => {
    const event = { sender: { id: 1 } }
    const reply = handlers.get('screenMarks:qaPlace')?.(event, { screenshotId: 'obs-1', shape: { kind: 'point', x: 1, y: 2 } })
    expect(assertMainWindow).toHaveBeenCalledWith(event)
    expect(reply).toEqual({ ok: true, markId: 'm1' })
    expect(place).toHaveBeenCalledWith({ screenshotId: 'obs-1', shape: { kind: 'point', x: 1, y: 2 } })
  })

  it('refuses malformed input without placing', () => {
    expect(handlers.get('screenMarks:qaPlace')?.({}, { screenshotId: '', shape: { kind: 'point', x: -5, y: 2 } })).toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect(handlers.get('screenMarks:qaPlace')?.({}, 'nope')).toEqual({ ok: false, reason: 'invalid' })
    expect(place).not.toHaveBeenCalled()
  })

  it('a refused sender never reaches the store', () => {
    assertMainWindow.mockImplementation(() => {
      throw new Error('IPC refused')
    })
    expect(() => handlers.get('screenMarks:qaPlace')?.({}, { screenshotId: 'obs-1', shape: { kind: 'point', x: 1, y: 2 } })).toThrow()
    expect(() => handlers.get('screenMarks:qaClear')?.({})).toThrow()
    expect(place).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
  })

  it('clears through the same checked path', () => {
    expect(handlers.get('screenMarks:qaClear')?.({})).toEqual({ ok: true })
    expect(clear).toHaveBeenCalled()
  })

  it('is enabled only for a packaged QA identity on an isolated profile with the flag set to 1', () => {
    const env = { ASKTOTO_USERDATA: '/isolated/profile', METIS_QA_SCREEN_MARKS: '1' }
    expect(qaScreenMarksEnabled({ qaIdentity: true, packaged: true, env })).toBe(true)
    expect(qaScreenMarksEnabled({ qaIdentity: false, packaged: true, env })).toBe(false)
    expect(qaScreenMarksEnabled({ qaIdentity: true, packaged: false, env })).toBe(false)
    expect(qaScreenMarksEnabled({ qaIdentity: true, packaged: true, env: { METIS_QA_SCREEN_MARKS: '1' } })).toBe(false)
    expect(qaScreenMarksEnabled({ qaIdentity: true, packaged: true, env: { ASKTOTO_USERDATA: '/p' } })).toBe(false)
    expect(
      qaScreenMarksEnabled({ qaIdentity: true, packaged: true, env: { ASKTOTO_USERDATA: '/p', METIS_QA_SCREEN_MARKS: 'true' } })
    ).toBe(false)
  })
})
