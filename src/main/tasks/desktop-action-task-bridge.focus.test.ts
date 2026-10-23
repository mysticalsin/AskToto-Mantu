import { describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest, DesktopActionResult } from '@shared/desktop-actions'
import { actionEnvelope } from '../action-guard'
import type { CommandExecutionContext } from '../command-control'
import { DesktopActionTaskBridge, type DesktopActionTaskBridgeDeps } from './desktop-action-task-bridge'
import type { TaskStateStore } from './encrypted-task-file-store'
import type { ForegroundHold } from './escape-release'
import type { FocusRequestStep, FocusStepResult } from './focus-request'
import type { TaskStateReadResult } from './task-persistence'

const SHUTTER: DesktopActionRequest = { id: 'desktop.photo_booth_capture', args: {} }
const NOTE: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'Groceries' } }

class MemoryStore implements TaskStateStore {
  serialized: string | null = null
  async read(): Promise<TaskStateReadResult> {
    return this.serialized === null ? { kind: 'not-found' } : { kind: 'found', serialized: this.serialized }
  }
  async write(serialized: string): Promise<void> {
    this.serialized = serialized
  }
  async quarantine(): Promise<void> {
    this.serialized = null
  }
}

const context = (proposalId: string, request: DesktopActionRequest, viaGrant = false): CommandExecutionContext => ({
  proposalId,
  owner: { webContentsId: 7, revision: 3 },
  ...actionEnvelope(proposalId, request),
  dependsOn: [],
  ...(viaGrant ? { viaGrant: true } : {})
})

function make(options: {
  platform?: NodeJS.Platform
  focus?: FocusRequestStep
  execute?: DesktopActionTaskBridgeDeps['execute']
}) {
  let id = 0
  const execute = vi.fn(
    options.execute ??
      (async (request: DesktopActionRequest): Promise<DesktopActionResult> => ({
        id: request.id,
        ok: true,
        outcome: 'unknown'
      }))
  )
  const audit = vi.fn()
  const bridge = new DesktopActionTaskBridge({
    execute,
    store: new MemoryStore(),
    authSessionGeneration: () => 1,
    newId: () => `id-${(id += 1)}`,
    now: () => 1_000_000,
    platform: options.platform ?? 'darwin',
    focus: options.focus,
    audit
  })
  return { bridge, execute, audit }
}

const granting = (): { step: FocusRequestStep; hold: ForegroundHold; run: ReturnType<typeof vi.fn> } => {
  const hold: ForegroundHold = { end: vi.fn(), escaped: new Promise(() => undefined) }
  const run = vi.fn(async (): Promise<FocusStepResult> => ({ ok: true, hold }))
  return { step: { run }, hold, run }
}

describe('foreground-only adapters pass through the focus-request step (G40)', () => {
  it('refuses a foreground-only action when no focus step is installed, and dispatches nothing', async () => {
    const { bridge, execute } = make({})
    const result = await bridge.execute(SHUTTER, context('p1', SHUTTER))
    expect(result).toMatchObject({ ok: false, outcome: 'failed', detail: 'task_denied:focus_unavailable' })
    expect(execute).not.toHaveBeenCalled()
    expect(bridge.snapshot()).toEqual([])
  })

  it('a declined focus request creates no task, dispatches nothing and says why in the audit', async () => {
    const run = vi.fn(async (): Promise<FocusStepResult> => ({ ok: false, reason: 'focus_declined', copy: 'no' }))
    const { bridge, execute, audit } = make({ focus: { run } })
    const result = await bridge.execute(SHUTTER, context('p2', SHUTTER))
    expect(result).toMatchObject({ ok: false, detail: 'task_denied:focus_declined' })
    expect(execute).not.toHaveBeenCalled()
    expect(bridge.snapshot()).toEqual([])
    expect(audit).toHaveBeenCalledWith('task.dispatch_denied', { actionId: SHUTTER.id, reason: 'focus_declined' })
  })

  it('a background adapter never asks for focus', async () => {
    const { step, run } = granting()
    const { bridge, execute } = make({ focus: step })
    await bridge.execute(NOTE, context('p3', NOTE))
    expect(run).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('Windows opens Camera in the background: no focus request there', async () => {
    const { step, run } = granting()
    const { bridge } = make({ platform: 'win32', focus: step })
    await bridge.execute(SHUTTER, context('p4', SHUTTER))
    expect(run).not.toHaveBeenCalled()
  })

  it('passes whether a grant approved the dispatch, dispatches once, and ends the hold afterwards', async () => {
    const { step, hold, run } = granting()
    const { bridge, execute } = make({ focus: step })
    await bridge.execute(SHUTTER, context('p5', SHUTTER, true))
    expect(run).toHaveBeenCalledWith(SHUTTER, expect.objectContaining({ viaGrant: true }))
    expect(execute).toHaveBeenCalledTimes(1)
    expect(hold.end).toHaveBeenCalledTimes(1)
  })

  it('ends the hold even when the adapter throws', async () => {
    const { step, hold } = granting()
    const { bridge } = make({
      focus: step,
      execute: async () => {
        throw new Error('adapter crashed')
      }
    })
    await bridge.execute(SHUTTER, context('p6', SHUTTER))
    expect(hold.end).toHaveBeenCalledTimes(1)
  })

  it('Escape stops the step: the lease aborts, and an effect that cannot be proven stays uncertain', async () => {
    let escape: () => void = () => undefined
    let adapterSignal: AbortSignal | undefined
    let release: () => void = () => undefined
    const run = vi.fn(async (_request: DesktopActionRequest, input: { stop(): void }): Promise<FocusStepResult> => {
      escape = input.stop
      return { ok: true, hold: { end: vi.fn(), escaped: new Promise(() => undefined) } }
    })
    const { bridge } = make({
      focus: { run },
      execute: (request, _envelope, signal) => {
        adapterSignal = signal
        // The adapter was already pressing the shutter: it finishes without a receipt.
        return new Promise((resolve) => {
          release = () => resolve({ id: request.id, ok: true, outcome: 'unknown' })
        })
      }
    })
    const running = bridge.execute(SHUTTER, context('p7', SHUTTER))
    await vi.waitFor(() => expect(adapterSignal).toBeDefined())
    expect(adapterSignal?.aborted).toBe(false)
    escape()
    expect(adapterSignal?.aborted).toBe(true)
    release()
    const result = await running
    expect(result.outcome).toBe('unknown')
    expect(bridge.snapshot()[0]?.effectOutcome).toBe('uncertain')
  })

  it('a stop that arrives during the focus decision dispatches nothing', async () => {
    const run = vi.fn(async (): Promise<FocusStepResult> => ({ ok: false, reason: 'focus_stopped', copy: 'stopped' }))
    const { bridge, execute } = make({ focus: { run } })
    const result = await bridge.execute(SHUTTER, context('p8', SHUTTER))
    expect(result).toMatchObject({ ok: false, outcome: 'cancelled', detail: 'stopped' })
    expect(execute).not.toHaveBeenCalled()
  })
})
