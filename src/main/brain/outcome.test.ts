import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Settings } from '@shared/ipc'
import { DealEntitySchema, type DealEntity } from '@shared/brain'
import { brainDir, readDeal, writeDeal, setDealOutcome, purgeBrain } from './store'
import { HUMAN_MARKS_FILE, readHumanMarks } from './human-marks'
import { settleBrainWritesForTests } from '../test-helpers/settle-brain-writes'
import { useStorageForTests } from '../infra/storage/meetings-storage'

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
  // MQA-007: settle the index-write lane BEFORE removing the profile. updateIndex writes
  // index.json through a tmp+rename, and a detached one can still be in flight here — under
  // parallel load the rename then lands on a directory this line already deleted, failing an
  // unrelated test in whichever file happened to be running.
  afterEach(async () => {
    await settleBrainWritesForTests()
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
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

describe('human-marks.json (D8-2 sidecar)', () => {
  let folder: string
  let s: Settings
  beforeEach(() => {
    useStorageForTests()
    folder = mkdtempSync(join(tmpdir(), 'asktoto-human-marks-file-'))
    s = { meetingsFolder: folder, encryptTranscripts: false } as Settings
  })
  afterEach(async () => {
    await settleBrainWritesForTests()
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  const plant = async (): Promise<void> => {
    await writeDeal(s, 'acme', DealEntitySchema.parse({ name: 'Acme', account: 'Acme' }))
  }

  it('setDealOutcome records the mark in the sidecar before the deal changes', async () => {
    await plant()
    await setDealOutcome(s, 'acme', 'won')
    const marks = await readHumanMarks(s)
    expect(marks.dealOutcomes.acme?.outcome).toBe('won')
    expect(readFileSync(join(brainDir(s), HUMAN_MARKS_FILE), 'utf8')).toContain('"v": 1')
  })

  it('human-marks.json survives purgeBrain(rebuild) next to corrections.json', async () => {
    await plant()
    await setDealOutcome(s, 'acme', 'lost')
    writeFileSync(join(brainDir(s), 'corrections.json'), '[]', 'utf8')

    expect(purgeBrain(s, { mode: 'rebuild', preserveCorrections: true })).toEqual({ ok: true })

    expect(readdirSync(brainDir(s)).sort()).toEqual(['corrections.json', HUMAN_MARKS_FILE])
    expect((await readHumanMarks(s)).dealOutcomes.acme?.outcome).toBe('lost')
    expect(readDeal(s, 'acme')).toBeNull()
  })

  it('purgeBrain(erase) removes the sidecar with everything else', async () => {
    await plant()
    await setDealOutcome(s, 'acme', 'won')
    expect(purgeBrain(s, { mode: 'erase' })).toEqual({ ok: true })
    expect(existsSync(brainDir(s))).toBe(false)
  })

  it('an unreadable sidecar is set aside, not overwritten', async () => {
    await plant()
    writeFileSync(join(brainDir(s), HUMAN_MARKS_FILE), '{ not json', 'utf8')
    await setDealOutcome(s, 'acme', 'won')
    const names = readdirSync(brainDir(s))
    expect(names.some((n) => n.startsWith('human-marks.corrupt-'))).toBe(true)
    expect((await readHumanMarks(s)).dealOutcomes.acme?.outcome).toBe('won')
  })
})
