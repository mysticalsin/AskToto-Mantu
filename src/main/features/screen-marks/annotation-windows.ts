import type { MarkView, Rect } from '@shared/screen-marks'

/**
 * The per-display annotation windows (G43, CAP-25), as a lifecycle independent of Electron:
 *  - lazily created the first time a display has a mark to draw, never before;
 *  - hidden (not destroyed) when that display has no marks left, shown again without focus when it has;
 *  - resized to follow the display's bounds, destroyed when the display is gone;
 *  - destroyAll() on sign-out, owner switch and quit.
 * The window itself (src/main/windows/annotation-window.ts) is non-activating, click-through and content-protected.
 */

export interface AnnotationWindowHandle {
  setBounds(bounds: Rect): void
  sendMarks(marks: MarkView[]): void
  /** Show without activating the app or taking keyboard focus. */
  showInactive(): void
  hide(): void
  destroy(): void
  isDestroyed(): boolean
}

export interface AnnotationDisplay {
  id: number
  bounds: Rect
}

export interface AnnotationWindows {
  sync(views: Map<number, MarkView[]>, displays: AnnotationDisplay[]): void
  destroyAll(): void
  count(): number
}

const sameBounds = (a: Rect, b: Rect): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

export function createAnnotationWindows(deps: {
  createWindow: (displayId: number, bounds: Rect) => AnnotationWindowHandle
  warn?: (message: string) => void
}): AnnotationWindows {
  const open = new Map<number, { win: AnnotationWindowHandle; bounds: Rect; visible: boolean }>()

  const drop = (id: number): void => {
    const entry = open.get(id)
    open.delete(id)
    try {
      if (entry && !entry.win.isDestroyed()) entry.win.destroy()
    } catch {
      // already gone
    }
  }

  function syncOne(display: AnnotationDisplay, marks: MarkView[]): void {
    let entry = open.get(display.id)
    if (entry?.win.isDestroyed()) {
      open.delete(display.id)
      entry = undefined
    }
    if (marks.length === 0) {
      if (entry?.visible) {
        entry.win.sendMarks([])
        entry.win.hide()
        entry.visible = false
      }
      return
    }
    if (!entry) {
      entry = { win: deps.createWindow(display.id, { ...display.bounds }), bounds: { ...display.bounds }, visible: false }
      open.set(display.id, entry)
    } else if (!sameBounds(entry.bounds, display.bounds)) {
      entry.win.setBounds({ ...display.bounds })
      entry.bounds = { ...display.bounds }
    }
    entry.win.sendMarks(marks)
    if (!entry.visible) {
      entry.win.showInactive()
      entry.visible = true
    }
  }

  return {
    sync(views, displays) {
      try {
        const live = new Set(displays.map((d) => d.id))
        for (const id of [...open.keys()]) if (!live.has(id)) drop(id)
        for (const display of displays) syncOne(display, views.get(display.id) ?? [])
      } catch (error) {
        deps.warn?.(`[screen-marks] annotation window failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    destroyAll() {
      for (const id of [...open.keys()]) drop(id)
    },
    count: () => open.size
  }
}
