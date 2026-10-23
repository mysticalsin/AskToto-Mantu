import { describe, expect, it } from 'vitest'
import type { MarkView, Rect } from '@shared/screen-marks'
import { createAnnotationWindows, type AnnotationWindowHandle } from './annotation-windows'

class FakeWindow implements AnnotationWindowHandle {
  destroyed = false
  visible = false
  bounds: Rect
  sent: MarkView[][] = []
  constructor(bounds: Rect) {
    this.bounds = bounds
  }
  setBounds(b: Rect): void {
    this.bounds = b
  }
  sendMarks(marks: MarkView[]): void {
    this.sent.push(marks)
  }
  showInactive(): void {
    this.visible = true
  }
  hide(): void {
    this.visible = false
  }
  destroy(): void {
    this.destroyed = true
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
}

const D1: Rect = { x: 0, y: 0, width: 1440, height: 900 }
const D2: Rect = { x: 1440, y: 0, width: 1920, height: 1080 }
const dot = (id: string): MarkView => ({ markId: id, kind: 'point', x: 1, y: 1 })

function setup() {
  const created: { displayId: number; win: FakeWindow }[] = []
  const windows = createAnnotationWindows({
    createWindow: (displayId, bounds) => {
      const win = new FakeWindow(bounds)
      created.push({ displayId, win })
      return win
    }
  })
  return { windows, created }
}

describe('annotation windows lifecycle (G43)', () => {
  it('creates no window until there is a mark, then one per display, shown without focus', () => {
    const { windows, created } = setup()
    windows.sync(new Map(), [{ id: 1, bounds: D1 }])
    expect(created).toHaveLength(0)
    windows.sync(new Map([[1, [dot('a')]]]), [
      { id: 1, bounds: D1 },
      { id: 2, bounds: D2 }
    ])
    expect(created.map((c) => c.displayId)).toEqual([1])
    expect(created[0].win.visible).toBe(true)
    expect(created[0].win.bounds).toEqual(D1)
    expect(created[0].win.sent.at(-1)).toEqual([dot('a')])
  })

  it('hides (not destroys) a window when its display has no marks, and shows it again later', () => {
    const { windows, created } = setup()
    const displays = [{ id: 1, bounds: D1 }]
    windows.sync(new Map([[1, [dot('a')]]]), displays)
    windows.sync(new Map(), displays)
    expect(created[0].win.visible).toBe(false)
    expect(created[0].win.destroyed).toBe(false)
    expect(created[0].win.sent.at(-1)).toEqual([])
    windows.sync(new Map([[1, [dot('b')]]]), displays)
    expect(created).toHaveLength(1)
    expect(created[0].win.visible).toBe(true)
  })

  it('follows a display bounds change and destroys the window of a removed display', () => {
    const { windows, created } = setup()
    windows.sync(
      new Map([
        [1, [dot('a')]],
        [2, [dot('b')]]
      ]),
      [
        { id: 1, bounds: D1 },
        { id: 2, bounds: D2 }
      ]
    )
    const moved: Rect = { x: 0, y: 0, width: 2560, height: 1440 }
    windows.sync(new Map([[1, [dot('a')]]]), [{ id: 1, bounds: moved }])
    expect(created[0].win.bounds).toEqual(moved)
    expect(created[1].win.destroyed).toBe(true)
  })

  it('recreates a window that was destroyed behind its back', () => {
    const { windows, created } = setup()
    const displays = [{ id: 1, bounds: D1 }]
    windows.sync(new Map([[1, [dot('a')]]]), displays)
    created[0].win.destroy()
    windows.sync(new Map([[1, [dot('a')]]]), displays)
    expect(created).toHaveLength(2)
  })

  it('destroyAll closes every window (sign-out, owner switch, quit) and later syncs build fresh ones', () => {
    const { windows, created } = setup()
    const displays = [{ id: 1, bounds: D1 }]
    windows.sync(new Map([[1, [dot('a')]]]), displays)
    windows.destroyAll()
    expect(created[0].win.destroyed).toBe(true)
    expect(windows.count()).toBe(0)
    windows.sync(new Map([[1, [dot('a')]]]), displays)
    expect(created).toHaveLength(2)
  })

  it('never lets a window failure escape into the caller', () => {
    const windows = createAnnotationWindows({
      createWindow: () => {
        throw new Error('no window')
      }
    })
    expect(() => windows.sync(new Map([[1, [dot('a')]]]), [{ id: 1, bounds: D1 }])).not.toThrow()
  })
})
