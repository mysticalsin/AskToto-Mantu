import { nativeImage, shell, type IpcMain } from 'electron'
import { currentPartitionId, onMemoryPartitionChange } from '../../memory-partition/memory-access'
import { registerArtifactsIpc } from '../../ipc/artifacts-ipc'
import { nodeArtifactFs } from './artifact-fs'
import { createArtifactRegistry, type ArtifactRegistry } from './registry'
import { createArtifactService } from './service'

export interface ComposeArtifactsDeps {
  ipcMain: Pick<IpcMain, 'handle' | 'on'>
  assertMainWindow(event: never): void
  requireAuth(): boolean
}

/** A 1x1 transparent PNG: the OS needs a drag icon, and the chip itself is the visible thing being dragged. */
const DRAG_ICON_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/**
 * The app's G53 composition: the in-memory artifact registry for the active memory partition, its service and IPC.
 * The single place that touches electron for artifacts. Records end with the owner.
 */
export function composeArtifacts(deps: ComposeArtifactsDeps): { registry: ArtifactRegistry } {
  const registry = createArtifactRegistry({ owner: currentPartitionId, fs: nodeArtifactFs, now: Date.now })
  const service = createArtifactService({
    registry,
    fs: nodeArtifactFs,
    openPath: (path) => shell.openPath(path),
    showItemInFolder: (path) => shell.showItemInFolder(path),
    now: Date.now
  })
  registerArtifactsIpc({
    ipcMain: deps.ipcMain,
    assertMainWindow: deps.assertMainWindow,
    requireAuth: deps.requireAuth,
    service,
    dragIcon: () => nativeImage.createFromDataURL(DRAG_ICON_PNG)
  })
  onMemoryPartitionChange(() => registry.clear())
  return { registry }
}
