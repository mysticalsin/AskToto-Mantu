import { describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest, DesktopActionResult } from '@shared/desktop-actions'
import type { GestureBinding, GestureTarget } from '@shared/gesture-binding'
import type { ResolvedRecipient } from '@shared/recipient-resolution'
import { actionEnvelope, type ActionEnvelope } from '../action-guard'
import type { CommandExecutionContext } from '../command-control'
import { DesktopActionTaskBridge } from './desktop-action-task-bridge'
import type { TaskStateStore } from './encrypted-task-file-store'
import type { TaskStateReadResult } from './task-persistence'

const NOTES: DesktopActionRequest = { id: 'desktop.open_notes', args: {} }
const MAIL: GestureTarget = { windowId: 'com.apple.mail', pid: 100, title: 'Inbox' }
const OWN_PID = 999

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

const verifiedFor = (request: DesktopActionRequest, envelope: ActionEnvelope): DesktopActionResult => ({
  id: request.id,
  ok: true,
  outcome: 'verified',
  receipt: { ...envelope, observation: 'The action is visible in its app' }
})
const ctx = (proposalId: string, request: DesktopActionRequest = NOTES): CommandExecutionContext => ({
  proposalId,
  owner: { webContentsId: 7, revision: 3 },
  ...actionEnvelope(proposalId, request),
  dependsOn: []
})
const binding = (target: GestureTarget | null = MAIL): GestureBinding => ({
  bindingId: 'b1',
  owner: { webContentsId: 7, revision: 3 },
  sessionId: 'command-1',
  target,
  capturedAtMs: 1_000
})

function make(opts: {
  binding?: GestureBinding | null
  front?: () => GestureTarget | null
  recipient?: (request: DesktopActionRequest) => ResolvedRecipient | null
}) {
  const execute = vi.fn(async (request: DesktopActionRequest, envelope: ActionEnvelope) =>
    verifiedFor(request, envelope)
  )
  const audit = vi.fn()
  let id = 0
  const bridge = new DesktopActionTaskBridge({
    execute,
    store: new MemoryStore(),
    authSessionGeneration: () => 1,
    audit,
    newId: () => `id-${(id += 1)}`,
    now: () => 1_000_000,
    gesture: {
      bindingFor: () => (opts.binding === undefined ? null : opts.binding),
      currentTarget: opts.front ?? (() => MAIL),
      ownPid: OWN_PID
    },
    ...(opts.recipient ? { recipient: { resolved: opts.recipient } } : {})
  })
  return { bridge, execute, audit }
}

describe('DesktopActionTaskBridge gesture binding (G34)', () => {
  it('dispatches when the app in front is still the one the gesture started in', async () => {
    const { bridge, execute } = make({ binding: binding() })
    const result = await bridge.execute(NOTES, ctx('p1'))
    expect(result.outcome).toBe('verified')
    expect(execute).toHaveBeenCalledOnce()
  })

  it('refuses with target_changed, dispatching nothing, when another app is in front at dispatch', async () => {
    const { bridge, execute, audit } = make({
      binding: binding(),
      front: () => ({ windowId: 'com.apple.safari', pid: 300, title: '' })
    })
    const result = await bridge.execute(NOTES, ctx('p1'))
    expect(execute).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, outcome: 'failed', detail: 'task_denied:target_changed' })
    expect(audit).toHaveBeenCalledWith('task.dispatch_denied', {
      actionId: 'desktop.open_notes',
      reason: 'target_changed'
    })
    expect(bridge.snapshot()).toHaveLength(0)
  })

  it('judges the binding read when the command was submitted, not one a later gesture installed', async () => {
    let current: GestureBinding | null = binding()
    const execute = vi.fn(async (request: DesktopActionRequest, envelope: ActionEnvelope) =>
      verifiedFor(request, envelope)
    )
    const bridge = new DesktopActionTaskBridge({
      execute,
      store: new MemoryStore(),
      authSessionGeneration: () => 1,
      gesture: {
        bindingFor: () => current,
        currentTarget: () => ({ windowId: 'com.apple.safari', pid: 300, title: '' }),
        ownPid: OWN_PID
      }
    })
    const pending = bridge.execute(NOTES, ctx('p1'))
    current = binding(null)
    expect(await pending).toMatchObject({ detail: 'task_denied:target_changed' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('does not constrain a command that never came from a gesture', async () => {
    const { bridge, execute } = make({ binding: null, front: () => ({ windowId: 'x', pid: 5, title: '' }) })
    expect((await bridge.execute(NOTES, ctx('p1'))).outcome).toBe('verified')
    expect(execute).toHaveBeenCalledOnce()
  })
})

describe('DesktopActionTaskBridge recipient gate (G34)', () => {
  // No current adapter addresses a person. This pins the gate for the first one that does: a recipient-bearing
  // request dispatches only to the one recipient main resolved from trusted UI state.
  const send = (to: string): DesktopActionRequest =>
    ({ id: 'desktop.create_note', args: { title: 'x', to } }) as unknown as DesktopActionRequest

  it('refuses a recipient that came with the request (model, transcript, screen) when nothing was resolved', async () => {
    const { bridge, execute, audit } = make({ binding: binding(), recipient: () => null })
    const hostile = send('bob@evil.example')
    const result = await bridge.execute(hostile, ctx('p1', hostile))
    expect(execute).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, detail: 'task_denied:recipient_unresolved' })
    expect(JSON.stringify(audit.mock.calls)).not.toContain('evil.example')
  })

  it('refuses when the request names someone other than the trusted resolution', async () => {
    const { bridge, execute } = make({
      binding: binding(),
      recipient: () => ({ address: 'alice@synthetic.test', source: 'explicit-pick' })
    })
    const hostile = send('bob@evil.example')
    expect(await bridge.execute(hostile, ctx('p1', hostile))).toMatchObject({
      detail: 'task_denied:recipient_unresolved'
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('refuses a recipient-bearing request when no resolver is wired', async () => {
    const { bridge, execute } = make({ binding: binding() })
    const req = send('alice@synthetic.test')
    expect(await bridge.execute(req, ctx('p1', req))).toMatchObject({ detail: 'task_denied:recipient_unresolved' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('dispatches when the request addresses exactly the trusted recipient', async () => {
    const { bridge, execute } = make({
      binding: binding(),
      recipient: () => ({ address: 'alice@synthetic.test', source: 'explicit-pick' })
    })
    const ok = send('Alice@Synthetic.test')
    expect((await bridge.execute(ok, ctx('p1', ok))).outcome).toBe('verified')
    expect(execute).toHaveBeenCalledOnce()
  })
})
