import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest } from '@shared/desktop-actions'
import { COMMAND_PROPOSAL_TTL_MS } from '@shared/metis-command-contract'
import { CommandControl } from './command-control'
import type { MetisCommandRuntime } from './metis-command-runtime'
import { resetDecisionProvidersState } from './operator-decision-providers-state'

// MQA-337: runtime expiry/retraction must revoke main-owned action approval immediately.

let runtime: MetisCommandRuntime | null = null

afterEach(() => {
  runtime?.destroy()
  runtime = null
  vi.useRealTimers()
})

async function createHarness() {
  // The register module owns a singleton. Load a fresh instance for each behavioral case.
  vi.resetModules()
  const { ensureMetisCommandRuntime } = await import('./metis-command-register')
  const execute = vi.fn(async (request: DesktopActionRequest) => ({
    id: request.id,
    ok: true,
    outcome: 'verified' as const
  }))
  const controller = new CommandControl({ platform: 'darwin', execute, policyAllows: () => true })
  let owner: { webContentsId: number } | null = { webContentsId: 11 }
  runtime = ensureMetisCommandRuntime({
    getSettings: () => ({}),
    commandControl: controller,
    getCommandOwner: () => owner
  })
  const confirmation = () => {
    const state = controller.getState()
    if (!state.proposalId) throw new Error('Expected an active command proposal')
    return { proposalId: state.proposalId, nonce: state.nonce, argsHash: state.argsHash, webContentsId: 11 }
  }
  return {
    controller,
    execute,
    confirmation,
    setOwner: (next: typeof owner) => {
      owner = next
    }
  }
}

describe('command runtime approval lifetime', () => {
  it('revokes main approval when the runtime proposal expires first', async () => {
    vi.useFakeTimers()
    const { controller, execute, confirmation } = await createHarness()
    runtime!.ingestTranscript('open notes', 'command')
    const stale = confirmation()

    await vi.advanceTimersByTimeAsync(COMMAND_PROPOSAL_TTL_MS)

    expect(controller.getState()).toEqual({ proposalId: null })
    expect(await controller.confirm(stale)).toEqual({ ok: false, reason: 'proposal_missing' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('revokes the old approval when a corrected utterance has no proposal', async () => {
    const { controller, execute, confirmation } = await createHarness()
    runtime!.ingestTranscript('open notes', 'command')
    const stale = confirmation()

    runtime!.ingestTranscript("actually don't open notes", 'command')

    expect(controller.getState()).toEqual({ proposalId: null })
    expect(await controller.confirm(stale)).toEqual({ ok: false, reason: 'proposal_missing' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('revokes the old approval when a replacement has no live owner', async () => {
    const { controller, execute, confirmation, setOwner } = await createHarness()
    runtime!.ingestTranscript('open notes', 'command')
    const stale = confirmation()
    setOwner(null)

    runtime!.ingestTranscript('open Arc', 'command')

    expect(controller.getState()).toEqual({ proposalId: null })
    expect(await controller.confirm(stale)).toEqual({ ok: false, reason: 'proposal_missing' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('revokes main approval when the command capture is stopped', async () => {
    const { controller, execute, confirmation } = await createHarness()
    runtime!.ingestTranscript('open notes', 'command')
    const stale = confirmation()

    runtime!.stopLocal('escape')

    expect(controller.getState()).toEqual({ proposalId: null })
    expect(await controller.confirm(stale)).toEqual({ ok: false, reason: 'proposal_missing' })
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('command JEV source', () => {
  const SEAT = { operatorUrl: 'https://operator.test', operatorIngestSecret: 'shared-secret-for-tests' }
  const SENTINEL = 'zz-sentinel-transcript-zz'

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    resetDecisionProvidersState()
  })

  async function harness(jevEnabled?: () => boolean) {
    vi.resetModules()
    const { ensureMetisCommandRuntime } = await import('./metis-command-register')
    const { recordDecisionProvidersFromHeartbeat: record } = await import('./operator-decision-providers-state')
    const proposeChecked = vi.fn(async () => null)
    const commandControl = { proposeChecked, revokeForLifecycleEvent: vi.fn() } as unknown as CommandControl
    const decide = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, adapterId: 'desktop.open_notes', confidence: 0.99 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
    vi.stubGlobal('fetch', decide)
    runtime = ensureMetisCommandRuntime({
      getSettings: () => SEAT,
      commandControl,
      getCommandOwner: () => ({ webContentsId: 11 }),
      ...(jevEnabled ? { jevEnabled } : {})
    })
    return { decide, proposeChecked, record }
  }

  it('defaults jevEnabled to the heartbeat source when opts.jevEnabled is absent', async () => {
    const { decide, record } = await harness()
    runtime!.ingestTranscript('create note', 'command')
    await Promise.resolve()
    expect(decide).not.toHaveBeenCalled()
    runtime!.stopLocal('escape')

    record(true, { decisionProviders: { jev: true } })
    runtime!.ingestTranscript('create note', 'command')
    await vi.waitFor(() => expect(decide).toHaveBeenCalled())
  })

  it('explicit opts.jevEnabled overrides the heartbeat source', async () => {
    const { decide, record } = await harness(() => false)
    record(true, { decisionProviders: { jev: true } })
    runtime!.ingestTranscript('create note', 'command')
    await Promise.resolve()
    expect(decide).not.toHaveBeenCalled()
  })

  it('with JEV on, a decide response never creates or alters a proposal', async () => {
    const off = await harness(() => false)
    runtime!.ingestTranscript('create note', 'command')
    await Promise.resolve()
    const baseline = off.proposeChecked.mock.calls.length
    runtime!.destroy()

    const on = await harness(() => true)
    runtime!.ingestTranscript('create note', 'command')
    await vi.waitFor(() => expect(on.decide).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(on.proposeChecked.mock.calls.length).toBe(baseline)
  })

  it('decide path writes no transcript text to console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    )
    const { decide } = await harness(() => true)
    runtime!.ingestTranscript(`create note ${SENTINEL}`, 'command')
    await vi.waitFor(() => expect(decide).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(SENTINEL)
  })
})
