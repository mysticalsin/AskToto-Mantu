import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Settings } from '@shared/ipc'
import { MeetingExtractionSchema, type MeetingExtraction } from '@shared/brain'

vi.mock('electron')

/**
 * MQA-162 — readJson hands every caller the SAME object for an unchanged file (store.ts's cache is keyed
 * by path+mtime+size, not by caller), so a read-modify-write that mutates that instance in place leaves
 * the cache advertising facts that were never persisted the moment the write fails — a OneDrive/AV lock
 * on `.brain`, ENOSPC, EACCES. writeSaved is the single lane every brain write goes through, so failing
 * exactly one target path there reproduces the real failure without a filesystem-wide mock (and without
 * destabilizing the brain suites that share `node:fs`).
 */
const failWriteTo = vi.hoisted(() => ({ suffix: '' }))
vi.mock('../transcripts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../transcripts')>()
  return {
    ...actual,
    writeSaved: async (file: string, content: string, encrypt: boolean): Promise<void> => {
      if (failWriteTo.suffix && file.replace(/\\/g, '/').endsWith(failWriteTo.suffix)) {
        const error = new Error('EPERM: simulated OneDrive lock on the entity file') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }
      return actual.writeSaved(file, content, encrypt)
    }
  }
})

// Imported AFTER the mock factory is declared (vi.mock is hoisted above this regardless of source order).
const { mergeExtraction, whenIndexWritesSettle } = await import('./ingest')
const { readAccount, readDeal, readGraph, readPerson, slugify } = await import('./store')

const extraction = (): MeetingExtraction =>
  MeetingExtractionSchema.parse({
    title24: 'Acme renewal',
    account: { name: 'Acme', sector: 'manufacturing', sector_confidence: 'INFERRED', confidence: 'EXTRACTED' },
    people: [{ name: 'Dana Ray', role: 'CTO', org: null, confidence: 'EXTRACTED' }],
    deal: {
      name: 'Acme renewal',
      stage: 'negotiation',
      win_likelihood_band: 'good',
      band_evidence: 'budget confirmed',
      velocity: { signal: 'hard-calendar-gate', evidence: 'board reviews on the 12th' }
    },
    signals: [{ kind: 'positive', statement: 'Budget confirmed', quote: 'we have the budget', confidence: 'EXTRACTED' }]
  })

const ACCOUNT = slugify('Acme')
const PERSON = slugify('Dana Ray')
const DEAL = slugify('Acme renewal')
const FIRST = { file: 'm1.md', date: '2026-03-01', title: 'first' }
const SECOND = { file: 'm2.md', date: '2026-03-02', title: 'second' }

describe('mergeExtraction — the cache never serves what the disk refused', () => {
  let folder: string
  let s: Settings

  beforeEach(async () => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-merge-cache-'))
    s = { meetingsFolder: folder } as Settings
    failWriteTo.suffix = ''
    // A first meeting that fully persists: it is what every assertion below compares against, and it is
    // what puts graph.json + the entity files on disk so the second merge reads them THROUGH the cache.
    await mergeExtraction(s, extraction(), FIRST)
  })

  afterEach(async () => {
    failWriteTo.suffix = ''
    await whenIndexWritesSettle()
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('MQA-162 — a failed account write leaves no unpersisted account or graph facts in the read cache', async () => {
    // Prime the cache with the persisted state — this is the very instance a later reader gets back.
    expect(readAccount(s, ACCOUNT)!.meetings.map((m) => m.file)).toEqual(['m1.md'])
    expect(readGraph(s).nodes.some((n) => n.id === `meeting:${slugify(SECOND.file)}`)).toBe(false)

    failWriteTo.suffix = `entities/account/${ACCOUNT}.json`
    await expect(mergeExtraction(s, extraction(), SECOND)).rejects.toThrow(/EPERM/)
    failWriteTo.suffix = ''

    expect(readAccount(s, ACCOUNT)!.meetings.map((m) => m.file)).toEqual(['m1.md'])
    expect(readGraph(s).nodes.some((n) => n.id === `meeting:${slugify(SECOND.file)}`)).toBe(false)
  })

  it('MQA-162 — a failed person write leaves no unpersisted person facts in the read cache', async () => {
    expect(readPerson(s, PERSON)!.meetings.map((m) => m.file)).toEqual(['m1.md'])

    failWriteTo.suffix = `entities/person/${PERSON}.json`
    await expect(mergeExtraction(s, extraction(), SECOND)).rejects.toThrow(/EPERM/)
    failWriteTo.suffix = ''

    expect(readPerson(s, PERSON)!.meetings.map((m) => m.file)).toEqual(['m1.md'])
  })

  it('MQA-162 — a failed deal write leaves no unpersisted deal facts in the read cache', async () => {
    expect(readDeal(s, DEAL)!.meetings.map((m) => m.file)).toEqual(['m1.md'])

    failWriteTo.suffix = `entities/deal/${DEAL}.json`
    await expect(mergeExtraction(s, extraction(), SECOND)).rejects.toThrow(/EPERM/)
    failWriteTo.suffix = ''

    expect(readDeal(s, DEAL)!.meetings.map((m) => m.file)).toEqual(['m1.md'])
  })
})
