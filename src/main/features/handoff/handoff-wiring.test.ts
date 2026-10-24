import { describe, expect, it, vi } from 'vitest'
import { readModuleSource } from '../../../test-helpers/module-source'
import { envelopeDigest, HANDOFF_ORIGINS } from './handoff-envelope'
import { CommandControl } from '../../command-control'
import { installHandoff, type HandoffApp } from './handoff-wiring'

const NOW = 1_800_000_000_000

function url(nonce: string): string {
  const base = {
    version: 1 as const,
    origin: HANDOFF_ORIGINS[0],
    nonce,
    issuedAt: NOW - 1000,
    expiresAt: NOW + 60_000,
    payload: { kind: 'note' as const, data: { title: 'Synthetic title' } }
  }
  const text = JSON.stringify({ ...base, digest: envelopeDigest(base) })
  return `metis://handoff?e=${Buffer.from(text).toString('base64url')}`
}
const nonce = (c: string): string => c.repeat(64)

function setup(
  over: {
    pending?: boolean
    window?: { isDestroyed(): boolean; webContents: { id: number } } | null
    packaged?: boolean
  } = {}
) {
  let openUrl: ((e: { preventDefault(): void }, u: string) => void) | undefined
  let secondInstance: ((e: unknown, argv: string[]) => void) | undefined
  const app: HandoffApp = {
    isPackaged: over.packaged ?? true,
    on: ((event: string, listener: never) => {
      if (event === 'open-url') openUrl = listener
      if (event === 'second-instance') secondInstance = listener
    }) as HandoffApp['on'],
    setAsDefaultProtocolClient: vi.fn(() => true),
    whenReady: () => Promise.resolve(),
    getPath: () => '/nonexistent-synthetic-userdata'
  }
  const proposeChecked = vi.fn(async (..._args: unknown[]) => ({ proposalId: 'p', nonce: 'n', argsHash: 'h' }))
  const audit = vi.fn()
  const window = over.window === undefined ? { isDestroyed: () => false, webContents: { id: 7 } } : over.window
  const runtime = installHandoff({
    app,
    commandControl: { proposeChecked, hasPendingProposal: () => over.pending === true },
    getWindow: () => window,
    audit,
    argv: [],
    nonceStore: { load: async () => ({}), save: async () => undefined },
    rateLimit: { take: () => true },
    now: () => NOW,
    sleep: async () => undefined
  })
  return {
    app,
    runtime,
    proposeChecked,
    audit,
    fire: (u: string) => openUrl?.({ preventDefault: () => undefined }, u),
    secondInstance: (argv: string[]) => secondInstance?.({}, argv)
  }
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

describe('installHandoff', () => {
  it('claims the metis scheme only when packaged', () => {
    expect(setup({ packaged: true }).app.setAsDefaultProtocolClient).toHaveBeenCalledWith('metis')
    expect(setup({ packaged: false }).app.setAsDefaultProtocolClient).not.toHaveBeenCalled()
  })

  it('open-url and second-instance argv both reach the confirm card with the live window as owner', async () => {
    const h = setup()
    h.fire(url(nonce('a')))
    h.secondInstance(['/app', '--x', url(nonce('b'))])
    await settle()
    expect(h.proposeChecked).toHaveBeenCalledTimes(2)
    expect(h.proposeChecked.mock.calls[0]).toEqual([
      { webContentsId: 7, revision: 1 },
      { id: 'desktop.create_note', args: { title: 'Synthetic title' } },
      { provenance: 'external' }
    ])
  })

  it('does not touch a pending card', async () => {
    const h = setup({ pending: true })
    h.fire(url(nonce('e')))
    await settle()
    expect(h.proposeChecked).not.toHaveBeenCalled()
    expect(h.audit).toHaveBeenCalledWith('handoff.rejected', { reason: 'busy' })
  })

  it('replays are refused and nothing is proposed without a live window', async () => {
    const h = setup()
    h.fire(url(nonce('c')))
    h.fire(url(nonce('c')))
    await settle()
    expect(h.proposeChecked).toHaveBeenCalledTimes(1)
    expect(h.audit).toHaveBeenCalledWith('handoff.rejected', { reason: 'replayed' })
    const none = setup({ window: null })
    none.fire(url(nonce('d')))
    await settle()
    expect(none.proposeChecked).not.toHaveBeenCalled()
    expect(none.audit).toHaveBeenCalledWith('handoff.rejected', { reason: 'not_shown' })
  })
})

describe('installHandoff with the real CommandControl (G37 final install fence)', () => {
  it('an owner card created while the external preflight is deferred is left untouched, and the handoff is refused', async () => {
    let releasePreflight: () => void = () => undefined
    let calls = 0
    const control = new CommandControl({
      platform: 'darwin',
      execute: async () => ({ id: 'desktop.create_note' as const, ok: true, outcome: 'unknown' as const }),
      policyAllows: () => true,
      preflight: () => {
        calls += 1
        return new Promise((resolve) => {
          releasePreflight = () => resolve({ ok: true })
        })
      }
    })
    const audit = vi.fn()
    installHandoff({
      app: {
        isPackaged: false,
        on: () => undefined,
        setAsDefaultProtocolClient: () => true,
        whenReady: () => Promise.resolve(),
        getPath: () => '/nonexistent-synthetic-userdata'
      },
      commandControl: control,
      getWindow: () => ({ isDestroyed: () => false, webContents: { id: 7 } }),
      audit,
      argv: [url(nonce('f'))],
      nonceStore: { load: async () => ({}), save: async () => undefined },
      rateLimit: { take: () => true },
      now: () => NOW,
      sleep: async () => undefined
    })
    await settle()
    expect(calls).toBe(1) // the external request is parked in its preflight
    expect(control.hasPendingProposal()).toBe(false)
    // The owner proposes their own card while that check is in flight.
    const ownerRequest = { id: 'desktop.create_note' as const, args: { title: 'Owner note', body: 'Mine' } }
    const owner = control.propose({ webContentsId: 7, revision: 100 }, ownerRequest)
    const before = control.getState()
    releasePreflight()
    await settle()
    const after = control.getState()
    expect(after).toEqual(before)
    expect(after.proposalId).toBe(owner.proposalId)
    expect(audit).toHaveBeenCalledWith('handoff.rejected', { reason: 'busy' })
    expect(audit).not.toHaveBeenCalledWith('handoff.accepted', expect.anything())
  })
})

describe('main wiring', () => {
  it('index.ts installs the handoff before ready (second-instance forwarding lives in installHandoff)', () => {
    const source = readModuleSource(__dirname, '../../index').text.replace(/\r\n/g, '\n')
    expect(source).toMatch(/const handoffDeps = \{ app, commandControl, getWindow: \(\) => win, audit: auditLog \}/)
    expect(source).toMatch(/installHandoff\(handoffDeps\)/)
  })
})
