import { join } from 'node:path'
import { app, type IpcMain } from 'electron'
import type { ScreenObservationIdentity, ScreenScope } from '@shared/screen-observation'
import { currentPartitionId, onMemoryPartitionChange } from '../../memory-partition/memory-access'
import { decryptSecret, encryptSecret } from '../../secrets'
import { createSnapshotObserver } from './observe'
import { createContextGrants, type ContextGrants } from './wiring'

export interface ComposeContextGrantsDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  assertMainWindow(event: never): void
  requireAuth(): boolean
  screenObservation: {
    capture(request: {
      reason: string
      scope?: ScreenScope
    }): Promise<{ image: string; observation: ScreenObservationIdentity }>
    generation(): number
    reconcile(): void
  }
  readText: ((image: string) => Promise<string | null>) | undefined
  foreground(): { title: string } | null
  /** The live session or conversation id, or a constant while none is open. */
  sessionId(): string
}

/**
 * The app's G46 composition: sealed snapshot files under the app's own data folder, owned by the active memory
 * partition, sealed with the app's secret key, ended with the partition. The single place that touches electron.
 */
export function composeContextGrants(deps: ComposeContextGrantsDeps): ContextGrants {
  return createContextGrants({
    ipcMain: deps.ipcMain,
    assertMainWindow: deps.assertMainWindow,
    requireAuth: deps.requireAuth,
    root: join(app.getPath('userData'), 'context-snapshots'),
    owner: currentPartitionId,
    generation: () => {
      deps.screenObservation.reconcile()
      return deps.screenObservation.generation()
    },
    sessionId: deps.sessionId,
    seal: encryptSecret,
    open: decryptSecret,
    onOwnerChange: onMemoryPartitionChange,
    observe: createSnapshotObserver({
      capture: (scope) => deps.screenObservation.capture({ reason: 'ask', scope }),
      readText: async (image) => (deps.readText ? deps.readText(image) : null),
      foreground: deps.foreground
    })
  })
}
