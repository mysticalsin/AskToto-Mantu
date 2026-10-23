import { describe, expect, it, vi } from 'vitest'
import { readModuleSource } from '../../../test-helpers/module-source'
import { envelopeDigest, HANDOFF_ORIGINS } from './handoff-envelope'
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
  over: { window?: { isDestroyed(): boolean; webContents: { id: number } } | null; packaged?: boolean } = {}
) {
  let openUrl: ((e: { preventDefault(): void }, u: string) => void) | undefined
  const app: HandoffApp = {
    isPackaged: over.packaged ?? true,
    on: (_event, listener) => {
      openUrl = listener
    },
    setAsDefaultProtocolClient: vi.fn(() => true),
    whenReady: () => Promise.resolve(),
    getPath: () => '/nonexistent-synthetic-userdata'
  }
  const proposeChecked = vi.fn(async () => ({ proposalId: 'p', nonce: 'n', argsHash: 'h' }))
  const audit = vi.fn()
  const window = over.window === undefined ? { isDestroyed: () => false, webContents: { id: 7 } } : over.window
  const runtime = installHandoff({
    app,
    commandControl: { proposeChecked },
    getWindow: () => window,
    audit,
    argv: [],
    now: () => NOW,
    sleep: async () => undefined
  })
  return { app, runtime, proposeChecked, audit, fire: (u: string) => openUrl?.({ preventDefault: () => undefined }, u) }
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
    h.runtime.fromArgv(['/app', '--x', url(nonce('b'))])
    await settle()
    expect(h.proposeChecked).toHaveBeenCalledTimes(2)
    expect(h.proposeChecked.mock.calls[0]).toEqual([
      { webContentsId: 7, revision: 1 },
      { id: 'desktop.create_note', args: { title: 'Synthetic title' } }
    ])
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

describe('main wiring', () => {
  it('index.ts installs the handoff before ready and forwards second-instance arguments', () => {
    const source = readModuleSource(__dirname, '../../index').text.replace(/\r\n/g, '\n')
    expect(source).toMatch(/installHandoff\(\{ app, commandControl, getWindow: \(\) => win, audit: auditLog \}\)/)
    expect(source).toMatch(/handoff\.fromArgv\(commandLine\)/)
  })
})
