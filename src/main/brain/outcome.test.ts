import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Settings } from '@shared/ipc'
import { DealEntitySchema, type DealEntity } from '@shared/brain'
import { brainDir, readDeal, writeDeal, setDealOutcome } from './store'

vi.mock('electron')

/**
 * setDealOutcome — the human closes the loop the LLM never may (DealEntitySchema.outcome defaults to
 * 'open' and has no other writer). Plants a deal entity straight onto a temp .brain/ dir (bypassing the
 * extraction pipeline — brain.test.ts already covers that) and drives the store function directly, in
 * both storage modes, mirroring e2e-proof.test.ts's plaintext/encrypted-at-rest split.
 */
describe.each([
  ['plaintext', false],
  ['encrypted-at-rest', true]
])('setDealOutcome (%s)', (_mode, encrypt) => {
  let folder: string
  let s: Settings

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-outcome-test-'))
    s = { meetingsFolder: folder, encryptTranscripts: encrypt } as Settings
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  const DEAL_SLUG = 'acme-core-banking'

  const plantDeal = async (overrides: Partial<DealEntity> = {}): Promise<DealEntity> => {
    const deal = DealEntitySchema.parse({ name: 'Acme Core Banking', account: 'Acme', ...overrides })
    await writeDeal(s, DEAL_SLUG, deal)
    return deal
  }

  it('round-trips open -> won -> open', async () => {
    await plantDeal()
    expect(readDeal(s, DEAL_SLUG)?.outcome).toBe('open')

    const won = await setDealOutcome(s, DEAL_SLUG, 'won')
    expect(won?.outcome).toBe('won')
    expect(readDeal(s, DEAL_SLUG)?.outcome).toBe('won')

    const reopened = await setDealOutcome(s, DEAL_SLUG, 'open')
    expect(reopened?.outcome).toBe('open')
    expect(readDeal(s, DEAL_SLUG)?.outcome).toBe('open')
  })

  it('persists to disk (through the same encryption-transparent path as every other brain write)', async () => {
    await plantDeal()
    await setDealOutcome(s, DEAL_SLUG, 'lost')

    const path = join(brainDir(s), 'entities', 'deal', `${DEAL_SLUG}.json`)
    const raw = readFileSync(path)
    if (encrypt) {
      expect(raw.subarray(0, 8).toString('utf8')).toBe('ATKENC2\n') // encrypted envelope, not plaintext
    } else {
      expect(raw.toString('utf8')).toContain('"outcome": "lost"')
    }
    // Fresh read from disk (not an in-memory cache) confirms the write landed either way.
    expect(readDeal(s, DEAL_SLUG)?.outcome).toBe('lost')
  })

  it('returns null and writes nothing for an unknown deal slug', async () => {
    const r = await setDealOutcome(s, 'does-not-exist', 'won')
    expect(r).toBeNull()
    expect(readDeal(s, 'does-not-exist')).toBeNull()
  })

  it('preserves the rest of the deal entity — only outcome changes', async () => {
    await plantDeal({ stage: 'defense', win_likelihood_band: 'mixed', band_evidence: 'price pressure' })
    const updated = await setDealOutcome(s, DEAL_SLUG, 'won')
    expect(updated?.stage).toBe('defense')
    expect(updated?.win_likelihood_band).toBe('mixed')
    expect(updated?.band_evidence).toBe('price pressure')
  })
})
