import { describe, expect, it } from 'vitest'
import {
  HELPER_SIZE,
  helperReducer,
  helperSupported,
  placeHelper,
  type HelperState,
  type Rect
} from './permission-helper'

/** C32 Part D — the guided grant helper's state machine, platform branches and placement. */
describe('helperReducer', () => {
  const open = (kind: 'screenRecording' | 'microphone', platform: 'darwin' | 'win32'): HelperState =>
    helperReducer(null, { type: 'open', kind, platform }) as HelperState

  it('open → waiting, with the drag item on macOS Screen Recording only', () => {
    const mac = open('screenRecording', 'darwin')
    expect(mac).toMatchObject({
      phase: 'waiting',
      drag: true,
      instruction: 'Drag Métis into the list, then turn it on.'
    })
    expect(mac.instruction).not.toMatch(/allow/i)
    for (const kind of ['screenRecording', 'microphone'] as const) {
      const win = open(kind, 'win32')
      expect(win.drag).toBe(false)
      expect(win.instruction).toMatch(/^Turn on /)
    }
  })

  it('a grant → granted → closed once the checkmark showed; macOS Screen Recording → relaunch', () => {
    const win = open('microphone', 'win32')
    const granted = helperReducer(win, { type: 'status', status: { granted: true, needsRelaunch: false } })
    expect(granted?.phase).toBe('granted')
    expect(helperReducer(granted, { type: 'success-shown' })?.phase).toBe('closed')
    const mac = helperReducer(open('screenRecording', 'darwin'), {
      type: 'status',
      status: { granted: true, needsRelaunch: true }
    })
    expect(mac?.phase).toBe('relaunch')
    // Relaunch waits for the person: a late success-shown does not close it.
    expect(helperReducer(mac, { type: 'success-shown' })?.phase).toBe('relaunch')
  })

  it('not granted yet changes nothing; cancel closes from any phase; nothing reopens a closed helper', () => {
    const waiting = open('screenRecording', 'darwin')
    expect(helperReducer(waiting, { type: 'status', status: { granted: false, needsRelaunch: true } })).toBe(waiting)
    for (const phase of ['waiting', 'granted', 'relaunch'] as const) {
      expect(helperReducer({ ...waiting, phase }, { type: 'cancel' })?.phase).toBe('closed')
    }
    const closed = { ...waiting, phase: 'closed' as const }
    expect(helperReducer(closed, { type: 'status', status: { granted: true, needsRelaunch: false } })).toBe(closed)
    expect(helperReducer(null, { type: 'cancel' })).toBeNull()
  })
})

describe('helperSupported', () => {
  it('macOS: Screen Recording only (the microphone keeps its native prompt); Windows: both; Linux: none', () => {
    expect(helperSupported('screenRecording', 'darwin')).toBe(true)
    expect(helperSupported('microphone', 'darwin')).toBe(false)
    expect(helperSupported('camera', 'darwin')).toBe(false)
    expect(helperSupported('screenRecording', 'win32')).toBe(true)
    expect(helperSupported('microphone', 'win32')).toBe(true)
    expect(helperSupported('screenRecording', 'linux')).toBe(false)
  })
})

describe('placeHelper', () => {
  const intersects = (a: Rect, b: Rect): boolean =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  const settingsOf = (work: Rect, w: number, h: number): Rect => {
    const sw = Math.min(w, work.width - 32)
    const sh = Math.min(h, work.height - 32)
    return { x: work.x + (work.width - sw) / 2, y: work.y + (work.height - sh) / 2, width: sw, height: sh }
  }

  it('sits beside the centered settings window, inside the work area, never over it', () => {
    for (const work of [
      { x: 0, y: 25, width: 1512, height: 919 },
      { x: 0, y: 25, width: 2560, height: 1415 },
      { x: -1920, y: 0, width: 1920, height: 1040 }
    ]) {
      const at = placeHelper(work, HELPER_SIZE, 'darwin')
      const box = { ...at, ...HELPER_SIZE }
      expect(at.towards).toBe('left')
      expect(intersects(box, settingsOf(work, 720, 620))).toBe(false)
      expect(box.x).toBeGreaterThanOrEqual(work.x)
      expect(box.x + box.width).toBeLessThanOrEqual(work.x + work.width)
      expect(box.y).toBeGreaterThanOrEqual(work.y)
      expect(box.y + box.height).toBeLessThanOrEqual(work.y + work.height)
    }
  })

  it('a narrow display puts it below or above; a tiny one falls back to the bottom-right corner', () => {
    const narrow = { x: 0, y: 0, width: 1100, height: 1200 }
    const below = placeHelper(narrow, HELPER_SIZE, 'darwin')
    expect(below.towards).toBe('up')
    expect(intersects({ ...below, ...HELPER_SIZE }, settingsOf(narrow, 720, 620))).toBe(false)
    const tiny = { x: 0, y: 0, width: 800, height: 600 }
    expect(placeHelper(tiny, HELPER_SIZE, 'win32')).toEqual({
      x: 800 - 16 - HELPER_SIZE.width,
      y: 600 - 16 - HELPER_SIZE.height,
      towards: 'left'
    })
  })
})
