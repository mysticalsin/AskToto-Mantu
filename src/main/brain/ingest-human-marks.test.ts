import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import type { StreamHandlers, StreamOptions, StreamHandle } from '../llm/shared'
import { getSettings, setApiKey, setSettings } from '../store'
import { MeetingExtractionSchema, type MeetingExtraction } from '@shared/brain'
import { brainBackfillProgress, finishRebuildReplay, ingestExtraction, settleCommitment, startRebuild } from './ingest'
import { mergeEntities, replayCorrections } from './corrections'
import { brainDir, setDealOutcome, purgeBrain, readDeal, readIndex, slugify, writeIndex } from './store'
import { applyHumanMarks } from './human-marks-apply'
import { readHumanMarks } from './human-marks'
import { useStorageForTests } from '../infra/storage/meetings-storage'
import { settleBrainWritesForTests } from '../test-helpers/settle-brain-writes'
import { installSpeechReadPolicy } from './__fixtures__/speech-read-policy'

vi.mock('electron')

const streamJson = vi.hoisted(() => ({ value: '{}' }))
vi.mock('../llm', () => ({
  createStream: vi.fn((opts: StreamOptions & { handlers: StreamHandlers }): StreamHandle => {
    queueMicrotask(() => {
      opts.handlers.onDelta(streamJson.value)
      opts.handlers.onDone({})
    })
    return { abort: () => {} }
  })
}))

const MD =
  '---\ntype: meeting-transcript\nmode: "meeting"\ndate: 2026-06-01\n---\n\nWe will send the revised pricing by Friday.'
const PROMISE = 'Send the revised pricing'

const extraction = (dealName = 'Acme Core Banking'): MeetingExtraction =>
  MeetingExtractionSchema.parse({
    account: { name: 'Acme', sector: 'banking', confidence: 'EXTRACTED' },
    deal: { name: dealName, stage: 'proposal' },
    commitments: [{ text: PROMISE, by: 'you', quote: '', confidence: 'EXTRACTED' }]
  })

describe('human marks survive a rebuild (Q04 / D8-2)', () => {
  let userData: string
  let meetingsFolder: string
  let restoreSpeechReadPolicy: () => void = () => {}

  const waitForIdle = async (): Promise<void> => {
    await vi.waitFor(() => expect(brainBackfillProgress().running).toBe(false), { timeout: 15_000 })
    await settleBrainWritesForTests()
  }

  beforeEach(() => {
    restoreSpeechReadPolicy = installSpeechReadPolicy()
    useStorageForTests()
    userData = mkdtempSync(join(tmpdir(), 'asktoto-human-marks-test-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'asktoto-human-marks-meetings-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })
    setSettings({ meetingsFolder })
    setApiKey('anthropic', 'fake-test-key-not-real')
    streamJson.value = '{}'
  })

  afterEach(async () => {
    try {
      await waitForIdle()
    } finally {
      restoreSpeechReadPolicy()
      rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      vi.restoreAllMocks()
    }
  })

  const seed = async (): Promise<{ dealSlug: string }> => {
    const s = getSettings()
    writeFileSync(join(meetingsFolder, 'm1.md'), MD, 'utf8')
    await ingestExtraction(s, extraction(), MD, join(meetingsFolder, 'm1.md'))
    const dealSlug = slugify('Acme Core Banking')
    expect(readDeal(s, dealSlug)?.outcome).toBe('open')
    expect(readDeal(s, dealSlug)?.commitments[0]?.status).toBe('open')
    return { dealSlug }
  }

  it('a deal outcome and a commitment settlement survive purge, re-extraction and replay', async () => {
    const s = getSettings()
    const { dealSlug } = await seed()
    await setDealOutcome(s, dealSlug, 'won')
    expect((await settleCommitment(s, dealSlug, PROMISE, 'kept')).ok).toBe(true)

    expect(purgeBrain(s, { mode: 'rebuild', preserveCorrections: true }).ok).toBe(true)
    expect(readDeal(s, dealSlug)).toBeNull()
    // Re-extraction recreates the commitment as open and the deal as open.
    await ingestExtraction(s, extraction(), MD, join(meetingsFolder, 'm1.md'))
    expect(readDeal(s, dealSlug)?.outcome).toBe('open')
    expect(readDeal(s, dealSlug)?.commitments[0]?.status).toBe('open')

    const idx = readIndex(s)
    idx.replayPending = true
    await writeIndex(s, idx)
    await finishRebuildReplay(s)

    expect(readDeal(s, dealSlug)?.outcome).toBe('won')
    expect(readDeal(s, dealSlug)?.commitments[0]?.status).toBe('kept')
    expect(readIndex(s).replayPending).toBe(false)
  })

  it('startRebuild with an extractor that recreates the commitment as open still ends won and kept', async () => {
    const s = getSettings()
    const { dealSlug } = await seed()
    await setDealOutcome(s, dealSlug, 'won')
    await settleCommitment(s, dealSlug, PROMISE, 'kept')
    streamJson.value = JSON.stringify(extraction())
    writeFileSync(join(brainDir(s), 'corrections.corrupt-2026-10-01.json'), 'damaged', 'utf8')

    const r = await startRebuild(s, { trigger: 'user' })
    expect(r.error).toBeUndefined()
    await vi.waitFor(() => expect(readIndex(getSettings()).replayPending).toBe(false), { timeout: 15_000 })
    await waitForIdle()

    expect(readDeal(s, dealSlug)?.outcome).toBe('won')
    expect(readDeal(s, dealSlug)?.commitments[0]?.status).toBe('kept')
    // D8-3: the quarantined journal copy left the wiped root for the preserved dir.
    expect(existsSync(join(brainDir(s), 'corrections.corrupt-2026-10-01.json'))).toBe(false)
    expect(readFileSync(join(meetingsFolder, '.brain-preserved', 'corrections.corrupt-2026-10-01.json'), 'utf8')).toBe(
      'damaged'
    )
  })

  it('marks follow a deal that a correction merged into another deal', async () => {
    const s = getSettings()
    const { dealSlug } = await seed()
    await setDealOutcome(s, dealSlug, 'lost')

    await ingestExtraction(s, extraction('Acme Platform'), MD, join(meetingsFolder, 'm1.md'))
    const target = slugify('Acme Platform')
    expect((await mergeEntities(s, { kind: 'deal', fromId: dealSlug, intoId: target })).ok).toBe(true)

    // Wipe derived state, rebuild both deals, replay the merge, then apply the marks.
    expect(purgeBrain(s, { mode: 'rebuild', preserveCorrections: true }).ok).toBe(true)
    await ingestExtraction(s, extraction(), MD, join(meetingsFolder, 'm1.md'))
    await ingestExtraction(s, extraction('Acme Platform'), MD, join(meetingsFolder, 'm1.md'))
    await replayCorrections(s)
    await applyHumanMarks(s)

    expect(readDeal(s, target)?.outcome).toBe('lost')
  })

  it('a mark for a commitment that no longer exists is kept and changes nothing', async () => {
    const s = getSettings()
    const { dealSlug } = await seed()
    await settleCommitment(s, dealSlug, PROMISE, 'broken')
    expect(Object.keys((await readHumanMarks(s)).commitmentStatus)).toHaveLength(1)
    expect(purgeBrain(s, { mode: 'rebuild', preserveCorrections: true }).ok).toBe(true)
    await ingestExtraction(
      s,
      MeetingExtractionSchema.parse({
        account: { name: 'Acme', sector: 'banking' },
        deal: { name: 'Acme Core Banking' }
      }),
      MD,
      join(meetingsFolder, 'm1.md')
    )
    expect((await applyHumanMarks(s)).applied).toBe(0)
    expect(Object.keys((await readHumanMarks(s)).commitmentStatus)).toHaveLength(1)
  })

  it('reopening a deal or commitment clears its mark', async () => {
    const s = getSettings()
    const { dealSlug } = await seed()
    await setDealOutcome(s, dealSlug, 'won')
    await settleCommitment(s, dealSlug, PROMISE, 'kept')
    await setDealOutcome(s, dealSlug, 'open')
    await settleCommitment(s, dealSlug, PROMISE, 'open')
    const marks = await readHumanMarks(s)
    expect(marks.dealOutcomes).toEqual({})
    expect(marks.commitmentStatus).toEqual({})
  })
})
