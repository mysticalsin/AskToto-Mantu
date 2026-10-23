import type { Rect, PlaceMarkResult, ScreenMarkShape } from '@shared/screen-marks'
import { createAnnotationWindows, type AnnotationDisplay, type AnnotationWindowHandle } from './annotation-windows'
import { createScreenMarks } from './screen-marks'

/**
 * The marks runtime without Electron (G43): the store, the per-display windows and the rules that tie them to the
 * screen observation. runtime.ts supplies the real displays, windows and events; the tests supply fakes.
 *
 *  - A frame issued for an Ask becomes the live screenshot; a prewarm, a self-check or a background frame does not
 *    (the person never saw it, so it must not invalidate marks they are looking at).
 *  - Any revocation (Stop, lock, sleep, Private View, lost permission, removed display, sign-out) clears every mark;
 *    sign-out also destroys the windows. `destroy()` does the same for owner switch and quit.
 */

/** The part of a G16 ScreenShot the marks need, declared here so this feature does not reach into another's internals. */
export interface IssuedFrame {
  observation: { observationId: string; generation: number }
  dispId: number
  width: number
  height: number
}

export type ScreenMarksEnd = 'owner-switch' | 'quit'

export interface ScreenMarksRuntimeCore {
  hooks: {
    onIssued(shot: IssuedFrame, request: { reason: string; region?: Rect }): void
    onRevoked(reason: string, generation: number): void
  }
  /** The seam the walkthrough and voice side place a mark through. */
  place(input: { screenshotId: string; shape: ScreenMarkShape }): PlaceMarkResult
  clear(reason: string): void
  displaysChanged(): void
  destroy(reason: ScreenMarksEnd): void
  markCount(): number
}

export function createScreenMarksRuntimeCore(deps: {
  displays: () => AnnotationDisplay[]
  createWindow: (displayId: number, bounds: Rect) => AnnotationWindowHandle
  newId: () => string
  warn?: (message: string) => void
}): ScreenMarksRuntimeCore {
  const store = createScreenMarks({
    displayBounds: (id) => deps.displays().find((d) => d.id === id)?.bounds ?? null,
    newId: deps.newId
  })
  const windows = createAnnotationWindows({ createWindow: deps.createWindow, warn: deps.warn })
  const sync = (): void => windows.sync(store.views(), deps.displays())
  store.onChange(sync)
  return {
    hooks: {
      onIssued(shot, request) {
        if (request.reason !== 'ask') return
        store.noteFrame({
          observationId: shot.observation.observationId,
          generation: shot.observation.generation,
          displayId: shot.dispId,
          screenshot: { width: shot.width, height: shot.height },
          ...(request.region ? { region: request.region } : {})
        })
      },
      onRevoked(reason) {
        store.clear(reason)
        if (reason === 'signed-out') windows.destroyAll()
      }
    },
    place: (input) => store.place(input),
    clear: (reason) => store.clear(reason),
    displaysChanged() {
      store.refresh()
      sync()
    },
    destroy(reason) {
      store.clear(reason)
      windows.destroyAll()
    },
    markCount: () => store.count()
  }
}
