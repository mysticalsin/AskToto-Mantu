import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { PROVIDER_IDS } from '@shared/providers'
import { BrainGraphSchema, BrainIndexSchema, MeetingExtractionSchema, PersonEntitySchema } from '@shared/brain'
import type { SaveMeeting, Settings } from '@shared/ipc'
import type { ContentPresence } from '../infra/storage/dataless'
import type { StorageFs } from '../infra/storage/gateway'
import { useStorageForTests } from '../infra/storage/meetings-storage'
import { getSettings, setSettings } from '../store'
import { recoverOrphanDrafts, saveDraftTranscript } from '../transcripts'
import { readBrainStatus } from './status'
import { loadIndex, readIndex, writeIndex } from './ledger'
import {
  brainBackfillProgress,
  enqueueIngest,
  reconcileMeetingsInBackground,
  requestBackfill,
  resumeBackfillIfPending,
  startBackfill,
  whenIndexWritesSettle
} from './ingest'
import { runConsolidationIfDue } from './consolidate'
import { catchUpIntelligenceIndexIfNeeded, setIntelligenceIndexWork, writeIntelligenceIndexState } from './intelligence-index'
import { scanMeetingSources } from './inputs'
import { brainDir, slugify, writeGraph, writeMeetingExtraction, writePerson } from './store'

const fsTrap = vi.hoisted(() => ({
  armed: false,
  calls: [] as string[],
  cloud: new Set<string>(),
  reads: [] as string[]
}))

vi.mock('electron')

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  const syncNames = [
    'accessSync',
    'appendFileSync',
    'chmodSync',
    'chownSync',
    'closeSync',
    'copyFileSync',
    'cpSync',
    'existsSync',
    'fchmodSync',
    'fchownSync',
    'fdatasyncSync',
    'fstatSync',
    'fsyncSync',
    'ftruncateSync',
    'futimesSync',
    'lchmodSync',
    'lchownSync',
    'linkSync',
    'lstatSync',
    'lutimesSync',
    'mkdirSync',
    'mkdtempSync',
    'openSync',
    'opendirSync',
    'readFileSync',
    'readdirSync',
    'readlinkSync',
    'readSync',
    'readvSync',
    'realpathSync',
    'renameSync',
    'rmSync',
    'rmdirSync',
    'statSync',
    'symlinkSync',
    'truncateSync',
    'unlinkSync',
    'utimesSync',
    'writeFileSync',
    'writeSync',
    'writevSync'
  ] as const
  const wrapped: Record<string, unknown> = { ...actual }
  for (const name of syncNames) {
    const fn = actual[name]
    if (typeof fn !== 'function') continue
    wrapped[name] = vi.fn((...args: unknown[]) => {
      if (fsTrap.armed) {
        for (const arg of args) {
          if (typeof arg !== 'string') continue
          const base = basename(arg)
          fsTrap.calls.push(`${name} ${base}`)
          if (fsTrap.cloud.has(base)) throw new Error(`${name} of a cloud-only file`)
        }
      }
      return (fn as (...inner: unknown[]) => unknown)(...args)
    })
  }
  return wrapped
})

const syncCallsOn = (...names: string[]): string[] => fsTrap.calls.filter((call) => names.includes(call.split(' ').at(-1) ?? ''))

const transcriptMd = (date: string, body: string): string => `---\ntype: meeting-transcript\nmode: "meeting"\ndate: ${date}\n---\n\n${body}\n`

function clearProviderEnv(): void {
  const providerEnv: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    grok: 'XAI_API_KEY',
    nvidia: 'NVIDIA_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    qwen: 'DASHSCOPE_API_KEY',
    minimax: 'MINIMAX_API_KEY',
    kimi: 'KIMI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    groq: 'GROQ_API_KEY',
    together: 'TOGETHER_API_KEY',
    fireworks: 'FIREWORKS_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    dust: 'DUST_API_KEY',
    'claude-cli': '',
    'codex-cli': '',
    gemini: 'GEMINI_API_KEY',
    custom: 'ASKTOTO_CUSTOM_API_KEY'
  }
  for (const p of PROVIDER_IDS) {
    const envVar = providerEnv[p]
    if (envVar) vi.stubEnv(envVar, '')
  }
}

function installStorage(): void {
  const fs: StorageFs = {
    readdir: fsp.readdir,
    realpath: fsp.realpath,
    stat: fsp.stat,
    async readFile(path) {
      fsTrap.reads.push(basename(path))
      return fsp.readFile(path)
    }
  }
  useStorageForTests({
    detector: {
      classify: vi.fn(async (files: readonly { path: string }[]): Promise<Map<string, ContentPresence>> => new Map(files.map((file): [string, ContentPresence] => [
        file.path,
        fsTrap.cloud.has(basename(file.path)) ? 'dataless' : 'local'
      ]))),
      markLocal: vi.fn()
    },
    fs
  })
}

async function waitForBrainIdle(): Promise<void> {
  await vi.waitFor(() => {
    const p = brainBackfillProgress()
    expect(p.running).toBe(false)
    expect(p.preparing).toBeFalsy()
  }, { timeout: 15_000 })
  await whenIndexWritesSettle()
}

async function seedExtraction(s: Settings, file: string, title = file): Promise<void> {
  await writeMeetingExtraction(
    s,
    slugify(file),
    MeetingExtractionSchema.parse({
      title24: title,
      account: { name: 'Local Account', sector: 'technology', confidence: 'EXTRACTED' }
    })
  )
}

function readIndexUnarmed(s: Settings): ReturnType<typeof readIndex> {
  fsTrap.armed = false
  try {
    return readIndex(s)
  } finally {
    fsTrap.armed = true
  }
}

describe('meetings-root stall-path readers', () => {
  let userData: string
  let meetingsFolder: string

  beforeEach(() => {
    fsTrap.armed = false
    fsTrap.calls.length = 0
    fsTrap.cloud.clear()
    fsTrap.reads.length = 0
    userData = mkdtempSync(join(tmpdir(), 'm2-0031-user-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'm2-0031-meetings-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
      if (name === 'userData') return userData
      return join(userData, name)
    })
    clearProviderEnv()
    setSettings({ meetingsFolder, encryptTranscripts: false })
    installStorage()
    fsTrap.armed = true
  })

  afterEach(async () => {
    await waitForBrainIdle()
    fsTrap.armed = false
    setIntelligenceIndexWork(null)
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('brain:status reads the ledger, counts and state files through the gateway, never synchronously', async () => {
    fsTrap.armed = false
    const s = getSettings()
    await loadIndex(s)
    await writeIndex(s, BrainIndexSchema.parse({ ingested: { 'local-meeting.md': { at: 1, ok: true } } }))
    await writePerson(s, 'person-a', PersonEntitySchema.parse({ id: 'person-a', name: 'Person A', meetings: [], quotes: [], stance_trail: [], commitments: [], aliases: [] }))
    await writeGraph(s, BrainGraphSchema.parse({ nodes: [{ id: 'n1', kind: 'person', label: 'Person A' }], edges: [] }))
    await writeIntelligenceIndexState({ lastSuccessAt: 123 }, s)
    await loadIndex(s)
    fsTrap.calls.length = 0
    fsTrap.reads.length = 0
    fsTrap.armed = true

    const result = await readBrainStatus(s)

    expect(result.meetings).toBe(1)
    expect(result.people).toBe(1)
    expect(result.nodes).toBe(1)
    expect(syncCallsOn('index.json', 'graph.json', 'person-a.json', 'intelligence-index.json', 'person', '.brain')).toEqual([])
  })

  it("brain:status reports a cloud-only index.json as indexUnavailable 'cloud-only' without reading it", async () => {
    fsTrap.armed = false
    const s = getSettings()
    await loadIndex(s)
    await writeIndex(s, BrainIndexSchema.parse({ ingested: { 'local-meeting.md': { at: 1, ok: true } } }))
    const markedAt = fsTrap.reads.length
    writeFileSync(join(brainDir(s), 'index.json'), JSON.stringify({ schema_version: 0, ingested: {} }), 'utf8')
    fsTrap.cloud.add('index.json')
    fsTrap.calls.length = 0
    fsTrap.armed = true

    const result = await readBrainStatus(s)

    expect(result.indexUnavailable).toBe('cloud-only')
    expect(result.error).toEqual(expect.stringMatching(/\S/))
    expect(fsTrap.reads.slice(markedAt)).not.toContain('index.json')
    expect(syncCallsOn('index.json')).toEqual([])
  })

  it('an index.json evicted with unchanged content stays usable from memory', async () => {
    fsTrap.armed = false
    const s = getSettings()
    await loadIndex(s)
    await writeIndex(s, BrainIndexSchema.parse({ ingested: { 'remembered.md': { at: 1, ok: true } } }))
    await loadIndex(s)
    fsTrap.cloud.add('index.json')
    fsTrap.calls.length = 0
    fsTrap.reads.length = 0
    fsTrap.armed = true

    const result = await readBrainStatus(s)

    expect(result.meetings).toBe(1)
    expect(fsTrap.reads).not.toContain('index.json')
    expect(syncCallsOn('index.json')).toEqual([])
  })

  it('boot resume scans through the gateway and never opens a cloud-only transcript or spends its attempt', async () => {
    fsTrap.armed = false
    const s = getSettings()
    writeFileSync(join(meetingsFolder, 'local-meeting.md'), transcriptMd('2026-01-01', 'local'), 'utf8')
    writeFileSync(join(meetingsFolder, 'cloud-meeting.md'), transcriptMd('2026-01-02', 'cloud'), 'utf8')
    await seedExtraction(s, 'local-meeting.md')
    await seedExtraction(s, 'cloud-meeting.md')
    await loadIndex(s)
    await writeIndex(s, BrainIndexSchema.parse({ backfillRequested: true }))
    fsTrap.cloud.add('cloud-meeting.md')
    fsTrap.calls.length = 0
    fsTrap.reads.length = 0
    fsTrap.armed = true

    await resumeBackfillIfPending()
    await waitForBrainIdle()

    const idx = readIndexUnarmed(s)
    expect(idx.ingested['local-meeting.md']?.ok).toBe(true)
    expect(idx.ingested['cloud-meeting.md']).toBeUndefined()
    expect(fsTrap.reads).not.toContain('cloud-meeting.md')
    expect(syncCallsOn('local-meeting.md', 'cloud-meeting.md', basename(meetingsFolder), 'index.json')).toEqual([])
  })

  it('reconcile detects drift of a cloud-only transcript from metadata alone', async () => {
    fsTrap.armed = false
    const s = getSettings()
    const file = join(meetingsFolder, 'drift-meeting.md')
    writeFileSync(file, transcriptMd('2026-01-03', 'drift'), 'utf8')
    await loadIndex(s)
    await writeIndex(s, BrainIndexSchema.parse({ ingested: { 'drift-meeting.md': { at: 1, ok: true, sourceVersion: 'old-version' } } }))
    utimesSync(file, new Date(), new Date(Date.now() + 10_000))
    fsTrap.cloud.add('drift-meeting.md')
    fsTrap.calls.length = 0
    fsTrap.reads.length = 0
    fsTrap.armed = true

    await reconcileMeetingsInBackground()
    await waitForBrainIdle()

    expect(readIndexUnarmed(s).sourceRefreshRequested).toBe(true)
    expect(fsTrap.reads).not.toContain('drift-meeting.md')
    expect(syncCallsOn('drift-meeting.md', basename(meetingsFolder))).toEqual([])
  })

  it('the launch catch-up skips a pass while its state file is cloud-only', async () => {
    fsTrap.armed = false
    const s = getSettings()
    await writeIntelligenceIndexState({ lastSuccessAt: 1 }, s)
    fsTrap.cloud.add('intelligence-index.json')
    const work = vi.fn(async () => ({ result: { ran: true, queued: 1 }, completion: Promise.resolve({ ok: true }) }))
    setIntelligenceIndexWork(work)
    fsTrap.calls.length = 0
    fsTrap.reads.length = 0
    fsTrap.armed = true

    const result = await catchUpIntelligenceIndexIfNeeded(Date.now(), s)

    expect(result).toEqual(expect.objectContaining({ ran: false, reason: 'unavailable' }))
    expect(work).not.toHaveBeenCalled()
    expect(fsTrap.reads).not.toContain('intelligence-index.json')
    expect(syncCallsOn('intelligence-index.json')).toEqual([])
  })

  it('consolidation skips a pass while its state file is cloud-only', async () => {
    fsTrap.armed = false
    const s = getSettings()
    setSettings({ brainConsolidation: { enabled: true, maxPassesPerDay: 2, preferLocal: true } })
    mkdirSync(brainDir(s), { recursive: true })
    writeFileSync(join(brainDir(s), 'consolidate-state.json'), JSON.stringify({ date: '2026-01-01', passes: 0, lastRunAt: 1 }), 'utf8')
    fsTrap.cloud.add('consolidate-state.json')
    fsTrap.calls.length = 0
    fsTrap.reads.length = 0
    fsTrap.armed = true

    const result = await runConsolidationIfDue(getSettings())

    expect(result).toEqual(expect.objectContaining({ ran: false, reason: 'unavailable' }))
    expect(brainBackfillProgress().total).toBe(0)
    expect(fsTrap.reads).not.toContain('consolidate-state.json')
    expect(syncCallsOn('consolidate-state.json')).toEqual([])
  })

  it('the dashboard-open backfill request lists and classifies without synchronous fs', async () => {
    fsTrap.armed = false
    const s = getSettings()
    writeFileSync(join(meetingsFolder, 'local-meeting.md'), transcriptMd('2026-01-04', 'local'), 'utf8')
    writeFileSync(join(meetingsFolder, 'cloud-meeting.md'), transcriptMd('2026-01-05', 'cloud'), 'utf8')
    await seedExtraction(s, 'local-meeting.md')
    await seedExtraction(s, 'cloud-meeting.md')
    fsTrap.cloud.add('cloud-meeting.md')
    fsTrap.calls.length = 0
    fsTrap.reads.length = 0
    fsTrap.armed = true

    await requestBackfill()
    await waitForBrainIdle()

    const idx = readIndexUnarmed(s)
    expect(idx.ingested['local-meeting.md']?.ok).toBe(true)
    expect(idx.ingested['cloud-meeting.md']).toBeUndefined()
    expect(syncCallsOn('local-meeting.md', 'cloud-meeting.md', basename(meetingsFolder))).toEqual([])
  })

  it('a transcript that is cloud-only when its extraction starts is left pending, not failed', async () => {
    fsTrap.armed = false
    const s = getSettings()
    const file = join(meetingsFolder, 'cloud-meeting.md')
    writeFileSync(file, transcriptMd('2026-01-06', 'cloud'), 'utf8')
    fsTrap.cloud.add('cloud-meeting.md')
    fsTrap.calls.length = 0
    fsTrap.reads.length = 0
    fsTrap.armed = true

    await enqueueIngest(file)
    await waitForBrainIdle()

    const record = readIndexUnarmed(s).ingested['cloud-meeting.md']
    if (record) {
      expect(record.ok).toBe(false)
      expect(record.attempts).toBe(0)
      expect(record.error).toBeUndefined()
      expect(record.retryAfter).toBeUndefined()
      expect(record.exhausted).toBeUndefined()
    }
    expect(fsTrap.reads).not.toContain('cloud-meeting.md')
    expect(syncCallsOn('cloud-meeting.md')).toEqual([])
  })

  it('draft recovery promotes local drafts and leaves cloud-only drafts unread', async () => {
    fsTrap.armed = false
    const first: SaveMeeting = {
      title: 'Local draft',
      mode: 'meeting',
      startedAt: 1_700_000_000_000,
      lines: [{ speaker: 'them', text: 'Local draft body', t: 1_700_000_000_000 }],
      recap: ''
    }
    const second: SaveMeeting = {
      title: 'Cloud draft',
      mode: 'meeting',
      startedAt: 1_700_000_060_000,
      lines: [{ speaker: 'them', text: 'Cloud draft body', t: 1_700_000_060_000 }],
      recap: ''
    }
    await saveDraftTranscript({ ...getSettings(), encryptTranscripts: false }, first)
    await saveDraftTranscript({ ...getSettings(), encryptTranscripts: false }, second)
    const drafts = (await fsp.readdir(meetingsFolder)).filter((file) => file.startsWith('.autosave-draft-')).sort()
    expect(drafts.length).toBe(2)
    const cloudDraft = drafts[1]
    fsTrap.cloud.add(cloudDraft)
    fsTrap.calls.length = 0
    fsTrap.reads.length = 0
    fsTrap.armed = true

    const result = await recoverOrphanDrafts(getSettings())

    expect(result.recovered).toBe(1)
    await fsp.access(join(meetingsFolder, cloudDraft))
    expect(fsTrap.reads).not.toContain(cloudDraft)
    expect(syncCallsOn(cloudDraft, basename(meetingsFolder))).toEqual([])
  })

  it('model work waits while a .brain merge input is cloud-only, and brain:status says so', async () => {
    fsTrap.armed = false
    const s = getSettings()
    writeFileSync(join(meetingsFolder, 'local-meeting.md'), transcriptMd('2026-01-07', 'local'), 'utf8')
    await seedExtraction(s, 'local-meeting.md')
    mkdirSync(join(brainDir(s), 'entities', 'person'), { recursive: true })
    writeFileSync(join(brainDir(s), 'entities', 'person', 'person-a.json'), '{}', 'utf8')
    fsTrap.cloud.add('person-a.json')
    fsTrap.calls.length = 0
    fsTrap.reads.length = 0
    fsTrap.armed = true

    const result = await startBackfill()
    const status = await readBrainStatus(getSettings())

    expect(result.queued).toBe(0)
    expect(status.error).toEqual(expect.stringMatching(/\S/))
    expect(fsTrap.reads).not.toContain('person-a.json')
    expect(syncCallsOn('person-a.json')).toEqual([])
  })
})
