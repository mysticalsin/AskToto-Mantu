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
type Authority = Readonly<{ readable: boolean; allowed: boolean; identity: string; inputAllowed: boolean }>
type IpcMain = Pick<Electron.IpcMain, 'handle' | 'removeHandler'>
type Owner = {
  identity: string
  navigation: number
  subscribed: boolean
  retired?: boolean
  readonly pending: Map<string, { readonly controller: AbortController; readonly settled: Promise<void> }>
  readonly hosts: Map<string, RuntimeWhisperHost>
}
const MAX_RUNTIME_WORKER_HOSTS = 2
const MAX_RUNTIME_WORKER_PENDING = 2
const OWNER_SETTLEMENT_MS = 15_000

function bounded<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('RUNTIME_WORKER_OWNER_UNSETTLED')), OWNER_SETTLEMENT_MS)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
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
    assertAudioCurrent: () => Promise<void>
  }) => Promise<RuntimeWhisperHost>
}): { cleanup(): Promise<void>; revokeAll(): Promise<void> } {
  const owners = new WeakMap<Electron.WebContents, Owner>()
  const liveOwners = new Set<Owner>()
  const usage = (): { pending: number; hosts: number } => {
    let pending = 0
    let hosts = 0
    for (const owner of liveOwners) {
      pending += owner.pending.size
      hosts += owner.hosts.size
    }
    return { pending, hosts }
  }
  const pruneOwner = (owner: Owner): void => {
    if (owner.retired && owner.pending.size === 0 && owner.hosts.size === 0) liveOwners.delete(owner)
  }
  const retainHostUntilSettled = (owner: Owner, requestId: string, host: RuntimeWhisperHost): void => {
    owner.hosts.set(requestId, host)
    void host.settled.then(() => {
      if (owner.hosts.get(requestId) === host) owner.hosts.delete(requestId)
      pruneOwner(owner)
    })
  }
  const revokeOwner = async (owner: Owner): Promise<void> => {
    owner.identity = randomBytes(16).toString('hex')
    owner.navigation += 1
    for (const pending of owner.pending.values()) pending.controller.abort(new Error('RUNTIME_WORKER_REVOKED'))
    await bounded(Promise.all([...owner.pending.values()].map((pending) => pending.settled)).then(() => undefined))
    await Promise.all(
      [...owner.hosts].map(async ([requestId, host]) => {
        await host.stop()
        await bounded(host.settled)
        if (owner.hosts.get(requestId) === host) owner.hosts.delete(requestId)
      })
    )
    pruneOwner(owner)
  }

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
        void revokeOwner(owner!).catch(() => undefined)
      })
      sender.once('destroyed', () => {
        owner!.retired = true
        void revokeOwner(owner!).catch(() => undefined)
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
    const counts = usage()
    if (
      counts.pending >= MAX_RUNTIME_WORKER_PENDING ||
      counts.hosts >= MAX_RUNTIME_WORKER_HOSTS ||
      context.owner.pending.size + context.owner.hosts.size >= 1
    )
      return { ok: false }
    const controller = new AbortController()
    let resolvePending!: () => void
    const settled = new Promise<void>((resolvePromise) => {
      resolvePending = resolvePromise
    })
    const pending = { controller, settled }
    context.owner.pending.set(requestId, pending)
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
      const assertAudioCurrent = async (): Promise<void> => {
        await assertCurrent()
        const authority = await options.readAuthority()
        context.assertCurrent()
        if (!authority.inputAllowed) throw new Error('RUNTIME_WORKER_CAPTURE_NOT_AUTHORIZED')
        if (snapshot(authority) !== authorityIdentity) throw new Error('RUNTIME_WORKER_AUTHORITY_CHANGED')
      }
      await assertCurrent()
      host = await options.createHost({ lease, assertCurrent, assertAudioCurrent })
      retainHostUntilSettled(context.owner, requestId, host)
      lease = null // the host owns the lease until its observed renderer-process exit
      await assertCurrent()
      if (context.owner.pending.get(requestId) !== pending) throw new Error('RUNTIME_WORKER_CANCELLED')
      const frame = event.senderFrame
      if (!frame) throw new Error('RUNTIME_WORKER_CALLER_STALE')
      frame.postMessage('metis-runtime-worker-port', { requestId }, [host.uiPort])
      return { ok: true, requestId }
    } catch (error) {
      if (error instanceof RetainedRuntimeWhisperHostError) {
        host = error.host
        lease = null
        retainHostUntilSettled(context.owner, requestId, host)
      }
      if (host) {
        await host.stop()
        await bounded(host.settled)
        if (context.owner.hosts.get(requestId) === host) context.owner.hosts.delete(requestId)
      }
      if (lease) await lease.release()
      return { ok: false }
    } finally {
      if (context.owner.pending.get(requestId) === pending) context.owner.pending.delete(requestId)
      resolvePending()
      pruneOwner(context.owner)
    }
  })

  options.ipcMain.handle(IPC.runtimeWhisperWorkerClose, async (event, input: unknown) => {
    const context = ownerFor(event)
    const parsed = CloseRequest.safeParse(input)
    if (!parsed.success) return { ok: false }
    const { requestId } = parsed.data
    context.owner.pending.get(requestId)?.controller.abort(new Error('RUNTIME_WORKER_CANCELLED'))
    const host = context.owner.hosts.get(requestId)
    if (!host) return { ok: true }
    try {
      await host.stop()
      if (context.owner.hosts.get(requestId) === host) context.owner.hosts.delete(requestId)
      pruneOwner(context.owner)
      context.assertCurrent()
      return { ok: true }
    } catch {
      // Keep the host and lease retained when renderer process exit cannot be observed.
      context.owner.hosts.set(requestId, host)
      return { ok: false }
    }
  })

  let handlersRemoved = false
  return {
    async revokeAll(): Promise<void> {
      await Promise.all([...liveOwners].map((owner) => revokeOwner(owner)))
    },
    async cleanup(): Promise<void> {
      if (!handlersRemoved) {
        handlersRemoved = true
        options.ipcMain.removeHandler(IPC.runtimeWhisperWorkerOpen)
        options.ipcMain.removeHandler(IPC.runtimeWhisperWorkerClose)
      }
      await Promise.all([...liveOwners].map((owner) => revokeOwner(owner)))
    }
  }
}
