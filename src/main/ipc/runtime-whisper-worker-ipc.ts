import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { IPC } from '@shared/ipc'
import type { RuntimeFeatureLease } from '../features/components/speech-pack/runtime-lease'
import {
  RetainedRuntimeWhisperHostError,
  type RuntimeWhisperHost
} from '../features/components/speech-pack/runtime-worker-host'

const OpenRequest = z.object({ requestId: z.string().regex(/^[0-9a-f]{32}$/) }).strict()
const CloseRequest = z.object({ requestId: z.string().regex(/^[0-9a-f]{32}$/) }).strict()
type Authority = Readonly<{ readable: boolean; allowed: boolean; identity: string }>
type IpcMain = Pick<Electron.IpcMain, 'handle' | 'removeHandler'>
type Owner = {
  identity: string
  navigation: number
  subscribed: boolean
  readonly pending: Map<string, AbortController>
  readonly hosts: Map<string, RuntimeWhisperHost>
}

function snapshot(value: Authority): string {
  if (
    !value ||
    value.readable !== true ||
    value.allowed !== true ||
    typeof value.identity !== 'string' ||
    value.identity.length < 1 ||
    value.identity.length > 2048
  ) {
    throw new Error('RUNTIME_WORKER_AUTHORITY_UNAVAILABLE')
  }
  return value.identity
}

/** Main-frame, navigation and fresh-authority bound access to one private Whisper renderer host. */
export function registerRuntimeWhisperWorkerIpc(options: {
  readonly ipcMain: IpcMain
  readonly assertMainWindow: (event: Electron.IpcMainInvokeEvent) => void
  readonly readAuthority: () => Promise<Authority>
  readonly acquireLease: (signal: AbortSignal) => Promise<RuntimeFeatureLease>
  readonly createHost: (input: {
    lease: RuntimeFeatureLease
    assertCurrent: () => Promise<void>
  }) => Promise<RuntimeWhisperHost>
}): { cleanup(): Promise<void> } {
  const owners = new WeakMap<Electron.WebContents, Owner>()
  const liveOwners = new Set<Owner>()

  const ownerFor = (event: Electron.IpcMainInvokeEvent): { owner: Owner; assertCurrent: () => void } => {
    options.assertMainWindow(event)
    const sender = event.sender
    let owner = owners.get(sender)
    if (!owner) {
      owner = {
        identity: randomBytes(16).toString('hex'),
        navigation: 0,
        subscribed: false,
        pending: new Map(),
        hosts: new Map()
      }
      owners.set(sender, owner)
      liveOwners.add(owner)
    }
    if (!owner.subscribed) {
      owner.subscribed = true
      sender.on('did-start-navigation', (details) => {
        if (!details.isMainFrame) return
        owner!.navigation += 1
        owner!.identity = randomBytes(16).toString('hex')
        for (const pending of owner!.pending.values()) pending.abort(new Error('RUNTIME_WORKER_STALE'))
        for (const [requestId, host] of owner!.hosts) {
          void host
            .stop()
            .then(() => {
              if (owner!.hosts.get(requestId) === host) owner!.hosts.delete(requestId)
            })
            .catch(() => undefined)
        }
        owner!.pending.clear()
      })
      sender.once('destroyed', () => {
        for (const pending of owner!.pending.values()) pending.abort(new Error('RUNTIME_WORKER_STALE'))
        for (const [requestId, host] of owner!.hosts) {
          void host
            .stop()
            .then(() => {
              if (owner!.hosts.get(requestId) === host) owner!.hosts.delete(requestId)
            })
            .catch(() => undefined)
        }
        owner!.pending.clear()
        liveOwners.delete(owner!)
      })
    }
    const frame = event.senderFrame
    if (!frame || frame.parent !== null) throw new Error('RUNTIME_WORKER_CALLER_INVALID')
    const url = sender.getURL()
    const ownerId = owner.identity
    const navigation = owner.navigation
    const identity = `${ownerId}:${frame.processId}:${frame.routingId}:${url}`
    const assertCurrent = (): void => {
      options.assertMainWindow(event)
      if (
        sender.isDestroyed() ||
        event.senderFrame !== frame ||
        sender.mainFrame !== frame ||
        frame.parent !== null ||
        sender.getURL() !== url ||
        owner!.navigation !== navigation ||
        owner!.identity !== ownerId ||
        identity !== `${ownerId}:${frame.processId}:${frame.routingId}:${url}`
      ) {
        throw new Error('RUNTIME_WORKER_CALLER_STALE')
      }
    }
    assertCurrent()
    return { owner, assertCurrent }
  }

  options.ipcMain.handle(IPC.runtimeWhisperWorkerOpen, async (event, input: unknown) => {
    const context = ownerFor(event)
    const parsed = OpenRequest.safeParse(input)
    if (
      !parsed.success ||
      context.owner.pending.has(parsed.data?.requestId ?? '') ||
      context.owner.hosts.has(parsed.data?.requestId ?? '')
    )
      return { ok: false }
    const { requestId } = parsed.data
    const controller = new AbortController()
    context.owner.pending.set(requestId, controller)
    let lease: RuntimeFeatureLease | null = null
    let host: RuntimeWhisperHost | null = null
    try {
      const authorityIdentity = snapshot(await options.readAuthority())
      context.assertCurrent()
      lease = await options.acquireLease(controller.signal)
      context.assertCurrent()
      const assertCurrent = async (): Promise<void> => {
        if (controller.signal.aborted) throw controller.signal.reason ?? new Error('RUNTIME_WORKER_CANCELLED')
        context.assertCurrent()
        if (snapshot(await options.readAuthority()) !== authorityIdentity)
          throw new Error('RUNTIME_WORKER_AUTHORITY_CHANGED')
        context.assertCurrent()
      }
      await assertCurrent()
      host = await options.createHost({ lease, assertCurrent })
      context.owner.hosts.set(requestId, host)
      lease = null // the host owns the lease until its observed renderer-process exit
      await assertCurrent()
      if (context.owner.pending.get(requestId) !== controller) throw new Error('RUNTIME_WORKER_CANCELLED')
      const frame = event.senderFrame
      if (!frame) throw new Error('RUNTIME_WORKER_CALLER_STALE')
      frame.postMessage('metis-runtime-worker-port', { requestId }, [host.uiPort])
      return { ok: true, requestId }
    } catch (error) {
      if (error instanceof RetainedRuntimeWhisperHostError) {
        host = error.host
        lease = null
        context.owner.hosts.set(requestId, host)
      }
      if (host) {
        try {
          await host.stop()
          if (context.owner.hosts.get(requestId) === host) context.owner.hosts.delete(requestId)
        } catch {
          // Retain the lease-owning host record when its renderer exit is uncertain.
        }
      }
      if (lease) await lease.release()
      return { ok: false }
    } finally {
      if (context.owner.pending.get(requestId) === controller) context.owner.pending.delete(requestId)
    }
  })

  options.ipcMain.handle(IPC.runtimeWhisperWorkerClose, async (event, input: unknown) => {
    const context = ownerFor(event)
    const parsed = CloseRequest.safeParse(input)
    if (!parsed.success) return { ok: false }
    const { requestId } = parsed.data
    context.owner.pending.get(requestId)?.abort(new Error('RUNTIME_WORKER_CANCELLED'))
    const host = context.owner.hosts.get(requestId)
    if (!host) return { ok: true }
    context.owner.hosts.delete(requestId)
    try {
      await host.stop()
      context.assertCurrent()
      return { ok: true }
    } catch {
      // Keep the host and lease retained when renderer process exit cannot be observed.
      context.owner.hosts.set(requestId, host)
      return { ok: false }
    }
  })

  let cleaned = false
  return {
    async cleanup(): Promise<void> {
      if (cleaned) return
      cleaned = true
      options.ipcMain.removeHandler(IPC.runtimeWhisperWorkerOpen)
      options.ipcMain.removeHandler(IPC.runtimeWhisperWorkerClose)
      const stopping: Promise<void>[] = []
      for (const owner of liveOwners) {
        for (const pending of owner.pending.values()) pending.abort(new Error('RUNTIME_WORKER_SHUTDOWN'))
        for (const host of owner.hosts.values()) stopping.push(host.stop())
      }
      await Promise.all(stopping)
    }
  }
}
