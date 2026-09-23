import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest } from '@shared/desktop-actions'
import { CommandControl } from './command-control'
import type { MetisCommandRuntime } from './metis-command-runtime'

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
  const controller = new CommandControl({ execute })
  let owner: { webContentsId: number } | null = { webContentsId: 11 }
  runtime = ensureMetisCommandRuntime({
    getSettings: () => ({}),
    commandControl: controller,
    getCommandOwner: () => owner
  })
  const confirmation = () => {
    const state = controller.getState()
    if (!state.proposalId) throw new Error('Expected an active command proposal')
    return { proposalId: state.proposalId, nonce: state.nonce, webContentsId: 11 }
  }
  return { controller, execute, confirmation, setOwner: (next: typeof owner) => { owner = next } }
}

describe('command runtime approval lifetime', () => {
  it('revokes main approval when the runtime proposal expires first', async () => {
    vi.useFakeTimers()
    const { controller, execute, confirmation } = await createHarness()
    runtime!.ingestTranscript('open notes', 'command')
    const stale = confirmation()

    await vi.advanceTimersByTimeAsync(5_000)

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
