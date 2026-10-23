import type { SnapshotKind } from '@shared/context-manifest'
import type { ScreenObservationIdentity, ScreenScope } from '@shared/screen-observation'
import type { ObservedContent } from './snapshot-store'

export interface SnapshotObserverDeps {
  /** One explicit, admitted capture (screen observation, reason `ask`). It carries the source id and generation. */
  capture(scope: ScreenScope): Promise<{ image: string; observation: ScreenObservationIdentity }>
  /** On-device reading of a frame (Vision OCR on macOS); null when this platform has none. Never leaves the device. */
  readText(image: string): Promise<string | null>
  /** The foreground window main last observed (its app or window title), or null. */
  foreground(): { title: string } | null
  now?(): number
}

const APP_MAX = 120

/** Window titles can carry control characters; provenance keeps a short, printable label only. */
const label = (title: string | undefined): string | null => {
  const clean = (title ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, APP_MAX)
  return clean || null
}

/**
 * Turns the owner's explicit snapshot request into an observation: one admitted capture, read on-device, with the
 * capture's own source id and generation and the foreground app main saw. It is called only from the snapshot request,
 * which only the owner's gesture can reach; no timer or watcher holds a reference to it.
 */
export function createSnapshotObserver(deps: SnapshotObserverDeps): (kind: SnapshotKind) => Promise<ObservedContent> {
  return async () => {
    const app = label(deps.foreground()?.title)
    const shot = await deps.capture({ kind: 'display' })
    const text = (await deps.readText(shot.image)) ?? ''
    return {
      sourceId: shot.observation.sourceId,
      observationId: shot.observation.observationId,
      generation: shot.observation.generation,
      capturedAt: shot.observation.capturedAt,
      text,
      app
    }
  }
}
