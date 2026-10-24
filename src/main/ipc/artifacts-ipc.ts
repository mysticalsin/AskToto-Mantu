import type { IpcMain, IpcMainEvent } from 'electron'
import {
  ARTIFACT_IPC,
  ArtifactIdRequestSchema,
  ArtifactTurnRequestSchema,
  type ArtifactActionResult,
  type TurnArtifacts
} from '@shared/artifact'
import type { ArtifactService, CopyPayload, PreviewDoc } from '../features/artifacts/service'

export interface ArtifactsIpcDeps {
  ipcMain: Pick<IpcMain, 'handle' | 'on'>
  /** Throws for any sender that is not the main window's top frame. */
  assertMainWindow(event: never): void
  requireAuth(): boolean
  service: ArtifactService
  /** The OS drag icon. A drag needs one on every platform. */
  dragIcon(): Electron.NativeImage | string
  /** Opens the sandboxed preview window (src/main/windows/). */
  showPreview(doc: PreviewDoc): void
  /** Writes to the system clipboard; throws when it cannot. */
  writeClipboard(payload: CopyPayload): void
}

const SIGNED_OUT = { ok: false, reason: 'signed-out' } as const
const INVALID = { ok: false, reason: 'invalid' } as const

/**
 * The renderer's view of G53. It names artifacts by id only: list a turn's chips, open, reveal, and start a drag-out.
 * Main resolves the id to the recorded path, checks the owner and verifies the file; no path ever arrives from the
 * renderer. Every channel is gated to the main window and a signed-in owner, and payloads are strict.
 */
export function registerArtifactsIpc(deps: ArtifactsIpcDeps): void {
  const { ipcMain, service } = deps
  const gate = (event: unknown): void => deps.assertMainWindow(event as never)

  ipcMain.handle(ARTIFACT_IPC.forTurn, async (event, raw): Promise<TurnArtifacts> => {
    gate(event)
    const empty = (turnId: string): TurnArtifacts => ({ manifest: { turnId, artifactIds: [] }, chips: [] })
    const parsed = ArtifactTurnRequestSchema.safeParse(raw)
    if (!parsed.success) return empty('invalid')
    if (!deps.requireAuth()) return empty(parsed.data.turnId)
    return service.forTurn(parsed.data.turnId)
  })

  for (const [channel, action] of [
    [ARTIFACT_IPC.open, (id: string) => service.open(id)],
    [ARTIFACT_IPC.reveal, (id: string) => service.reveal(id)],
    [ARTIFACT_IPC.arm, (id: string) => service.arm(id)],
    [ARTIFACT_IPC.preview, (id: string) => service.preview(id, deps.showPreview)],
    [ARTIFACT_IPC.copy, (id: string) => service.copy(id, deps.writeClipboard)]
  ] as const) {
    ipcMain.handle(channel, async (event, raw): Promise<ArtifactActionResult> => {
      gate(event)
      if (!deps.requireAuth()) return SIGNED_OUT
      const parsed = ArtifactIdRequestSchema.safeParse(raw)
      return parsed.success ? action(parsed.data.artifactId) : INVALID
    })
  }

  // Fire-and-forget: the drag has to start inside the dragstart gesture, so this is a send, not an invoke.
  ipcMain.on(ARTIFACT_IPC.dragStart, (event: IpcMainEvent, raw: unknown) => {
    try {
      gate(event)
    } catch {
      return
    }
    if (!deps.requireAuth()) return
    const parsed = ArtifactIdRequestSchema.safeParse(raw)
    if (!parsed.success) return
    service.dragStart(parsed.data.artifactId, (item) => {
      event.sender.startDrag({ file: item.file, icon: deps.dragIcon() as Electron.NativeImage })
    })
  })
}
