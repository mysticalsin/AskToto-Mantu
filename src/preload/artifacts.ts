import type { IpcRenderer } from 'electron'
import { ARTIFACT_IPC, type ArtifactActionResult, type TurnArtifacts } from '../shared/artifact'

/**
 * The renderer's side of G53: list the files a turn produced (ids, names, sizes and a verified status, never a path)
 * and open, reveal or drag one by `artifactId`. Main resolves the id; the renderer never names a path.
 */
export function createArtifactsPreloadApi(ipc: Pick<IpcRenderer, 'invoke' | 'send'>): {
  getTurnArtifacts(turnId: string): Promise<TurnArtifacts>
  openArtifact(artifactId: string): Promise<ArtifactActionResult>
  revealArtifact(artifactId: string): Promise<ArtifactActionResult>
  armArtifactDrag(artifactId: string): Promise<ArtifactActionResult>
  startArtifactDrag(artifactId: string): void
} {
  return {
    getTurnArtifacts: (turnId) => ipc.invoke(ARTIFACT_IPC.forTurn, { turnId }),
    openArtifact: (artifactId) => ipc.invoke(ARTIFACT_IPC.open, { artifactId }),
    revealArtifact: (artifactId) => ipc.invoke(ARTIFACT_IPC.reveal, { artifactId }),
    armArtifactDrag: (artifactId) => ipc.invoke(ARTIFACT_IPC.arm, { artifactId }),
    startArtifactDrag: (artifactId) => ipc.send(ARTIFACT_IPC.dragStart, { artifactId })
  }
}
