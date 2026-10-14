import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { IPC } from '@shared/ipc'
import type {
  RuntimeInstallCallerContext,
  RuntimeInstallPlanBook
} from '../features/components/speech-pack/runtime-install-plans'
import type { RuntimeInstallPlanPreview, RuntimeInstallResponse } from '../../shared/runtime-install'
import type { RuntimeFeatureId } from '../features/components/speech-pack/runtime-lease'

type RuntimeInstallIpcMain = Pick<Electron.IpcMain, 'handle' | 'removeHandler'>
const Feature = z.enum(['offline-asr', 'speaker-embedding', 'local-llm'])
const PreviewRequest = z.object({ feature: Feature }).strict()
const InstallRequest = z
  .object({ planId: z.string().regex(/^[0-9a-f]{64}$/), action: z.enum(['install', 'cancel']) })
  .strict()
const ErrorReason = z.enum(['not-configured', 'stale-plan', 'cancelled', 'unavailable'])

function reasonFor(error: unknown): z.infer<typeof ErrorReason> {
  const code = error instanceof Error ? error.message : ''
  if (code === 'RUNTIME_INSTALL_CANCELLED') return 'cancelled'
  if (/PLAN_(?:EXPIRED|STALE|CATALOG_CHANGED|CLOSURE_CHANGED)|CALLER_CHANGED/.test(code)) return 'stale-plan'
  if (/NOT_CONFIGURED|UNAVAILABLE|NOT_SELECTED|TARGET/.test(code)) return 'not-configured'
  return 'unavailable'
}

/** Main-frame and navigation-bound consent IPC. The renderer can supply only a closed feature and plan id. */
export function registerRuntimeInstallIpc(options: {
  readonly ipcMain: RuntimeInstallIpcMain
  readonly assertMainWindow: (event: Electron.IpcMainInvokeEvent) => void
  readonly plans: RuntimeInstallPlanBook
}): { cleanup(): void } {
  const owners = new WeakMap<Electron.WebContents, { identity: string; navigation: number; subscribed: boolean }>()
  const caller = (event: Electron.IpcMainInvokeEvent): RuntimeInstallCallerContext => {
    options.assertMainWindow(event)
    const sender = event.sender
    let owner = owners.get(sender)
    if (!owner) {
      owner = { identity: randomBytes(16).toString('hex'), navigation: 0, subscribed: false }
      owners.set(sender, owner)
    }
    if (!owner.subscribed) {
      owner.subscribed = true
      sender.on('did-start-navigation', (details) => {
        if (details.isMainFrame) {
          owner!.navigation += 1
          owner!.identity = randomBytes(16).toString('hex')
        }
      })
    }
    const frame = event.senderFrame
    if (!frame || frame.parent !== null) throw new Error('RUNTIME_INSTALL_CALLER_CHANGED')
    const url = sender.getURL()
    const identity = `${owner.identity}:${frame.processId}:${frame.routingId}:${url}`
    const navigation = owner.navigation
    const assertCurrent = (): void => {
      options.assertMainWindow(event)
      if (
        sender.isDestroyed() ||
        event.sender !== sender ||
        event.senderFrame !== frame ||
        sender.mainFrame !== frame ||
        frame.parent !== null ||
        sender.getURL() !== url ||
        owner!.navigation !== navigation ||
        owner!.identity !== identity.split(':', 1)[0]
      ) {
        throw new Error('RUNTIME_INSTALL_CALLER_CHANGED')
      }
    }
    assertCurrent()
    return Object.freeze({ identity, assertCurrent })
  }

  options.ipcMain.handle(IPC.runtimeInstallPlanPreview, async (event, input: unknown) => {
    const context = caller(event)
    const parsed = PreviewRequest.safeParse(input)
    if (!parsed.success) return null
    const preview = await options.plans.preview(parsed.data.feature as RuntimeFeatureId, context)
    context.assertCurrent()
    return preview as RuntimeInstallPlanPreview | null
  })
  options.ipcMain.handle(IPC.runtimeInstallWithPlan, async (event, input: unknown): Promise<RuntimeInstallResponse> => {
    const context = caller(event)
    const parsed = InstallRequest.safeParse(input)
    if (!parsed.success) return { ok: false, reason: 'unavailable' }
    try {
      const result = await options.plans.installWithPlan({ ...parsed.data, caller: context })
      context.assertCurrent()
      if ('cancelled' in (result as Record<string, unknown>)) return { cancelled: true }
      const completed = result as { generationIdentity?: unknown; installedBytes?: unknown }
      if (
        typeof completed.generationIdentity !== 'string' ||
        !/^[0-9a-f]{64}$/.test(completed.generationIdentity) ||
        !Number.isSafeInteger(completed.installedBytes) ||
        (completed.installedBytes as number) < 1
      ) {
        return { ok: false, reason: 'unavailable' }
      }
      return {
        ok: true,
        generationIdentity: completed.generationIdentity,
        installedBytes: completed.installedBytes as number
      }
    } catch (error) {
      context.assertCurrent()
      return { ok: false, reason: reasonFor(error) }
    }
  })

  let cleaned = false
  return {
    cleanup(): void {
      if (cleaned) return
      cleaned = true
      options.plans.clear()
      options.ipcMain.removeHandler(IPC.runtimeInstallPlanPreview)
      options.ipcMain.removeHandler(IPC.runtimeInstallWithPlan)
    }
  }
}
