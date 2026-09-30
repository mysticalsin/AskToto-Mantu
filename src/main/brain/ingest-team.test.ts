import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { PROVIDER_IDS } from '@shared/providers'
import { BrainIndexSchema, MeetingExtractionSchema } from '@shared/brain'
import { getSettings, setSettings } from '../store'
import { brainBackfillProgress, extractionSlug, startBackfill } from './ingest'
import { readIndex, readMeetingExtraction, writeIndex, writeMeetingExtraction } from './store'
import { useStorageForTests } from '../infra/storage/meetings-storage'
import { settleBrainWritesForTests } from '../test-helpers/settle-brain-writes'

vi.mock('electron')

/**
 * Team-transcript centralization (settings.teamTranscriptFolders): a shared folder's transcripts are
 * ingested into THIS brain, namespaced in the index as "team/<owner>/<file>" so they never collide with
 * the user's own meetings, and attributed via the extraction's source_team. These tests drive the
 * no-provider reconcile path (a pre-written saved extraction is merged locally), so they need no LLM call —
 * the same technique ingest-backfill.test.ts uses for its checkpoint-repair cases.
 */
describe('team-transcript ingest', () => {
  let userData: string
  let meetingsFolder: string
  let sharedRoot: string

  beforeEach(() => {
    useStorageForTests()
    userData = mkdtempSync(join(tmpdir(), 'asktoto-team-userdata-'))
    meetingsFolder = mkdtempSync(join(tmpdir(), 'asktoto-team-meetings-'))
    sharedRoot = mkdtempSync(join(tmpdir(), 'asktoto-team-shared-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'userData' ? userData : join(userData, name)
    )
    // Clear every provider env var so no provider silently resolves (a real key in the runner's shell
    // would defeat the no-provider reconcile path). Mirrors ingest-backfill.test.ts.
    for (const p of PROVIDER_IDS) {
      const envVar = {
        anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', nvidia: 'NVIDIA_API_KEY',
        deepseek: 'DEEPSEEK_API_KEY', qwen: 'DASHSCOPE_API_KEY', minimax: 'MINIMAX_API_KEY',
        kimi: 'KIMI_API_KEY', openrouter: 'OPENROUTER_API_KEY', groq: 'GROQ_API_KEY', grok: 'XAI_API_KEY',
        together: 'TOGETHER_API_KEY', fireworks: 'FIREWORKS_API_KEY', mistral: 'MISTRAL_API_KEY',
        dust: 'DUST_API_KEY', 'claude-cli': '', 'codex-cli': '', gemini: 'GEMINI_API_KEY',
        cloudflare: 'CLOUDFLARE_API_KEY', local: '', custom: 'ASKTOTO_CUSTOM_API_KEY'
      }[p]
      if (envVar) vi.stubEnv(envVar, '')
    }
  })

  afterEach(async () => {
    // Seeing the first durable ingested record is not the same as the full queue becoming idle: backfill
    // finalization still schedules its lint/publication/index writes after that point. Wait for the real
    // worker lifecycle first, then its serialized index tail, before deleting this profile.
    await vi.waitFor(() => expect(brainBackfillProgress().running).toBe(false), { timeout: 10_000 })
    await settleBrainWritesForTests()
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    rmSync(sharedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    delete process.env.ASKTOTO_LEDGER_USERDATA
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('ingests a team transcript under a namespaced key with source_team attribution', async () => {
    const teamFolder = join(sharedRoot, 'alice')
    mkdirSync(teamFolder)
    const file = 'weekly-sync.md'
    writeFileSync(join(teamFolder, file), '---\ndate: 2026-02-01\n---\nAlice weekly sync notes.', 'utf8')
    setSettings({ meetingsFolder, teamTranscriptFolders: [teamFolder] })
    // Pre-write the saved extraction under the NAMESPACED slug so startBackfill merges it locally (no LLM).
    const key = `team/alice/${file}`
    await writeMeetingExtraction(getSettings(), extractionSlug(key), MeetingExtractionSchema.parse({ title24: 'Alice sync' }))

    await startBackfill()

    await vi.waitFor(() => {
      // Indexed under the namespaced key — NOT the bare basename.
      expect(readIndex(getSettings()).ingested[key]?.ok).toBe(true)
    }, { timeout: 10_000 })
    expect(readIndex(getSettings()).ingested[file]).toBeUndefined()
    // Attribution: the ingest job re-stamps the stored extraction with the folder owner.
    expect(readMeetingExtraction(getSettings(), extractionSlug(key))?.source_team).toBe('alice')
  })

  it('does not collide a team file with an own meeting of the same basename — both ingest independently', async () => {
    const teamFolder = join(sharedRoot, 'bob')
    mkdirSync(teamFolder)
    const file = 'standup.md'
    // Identical basename in the user's OWN folder and in bob's shared team folder.
    writeFileSync(join(meetingsFolder, file), '---\ndate: 2026-02-02\n---\nMy own standup.', 'utf8')
    writeFileSync(join(teamFolder, file), '---\ndate: 2026-02-02\n---\nBob standup.', 'utf8')
    setSettings({ meetingsFolder, teamTranscriptFolders: [teamFolder] })
    await writeMeetingExtraction(getSettings(), extractionSlug(file), MeetingExtractionSchema.parse({ title24: 'My standup' }))
    await writeMeetingExtraction(getSettings(), extractionSlug(`team/bob/${file}`), MeetingExtractionSchema.parse({ title24: 'Bob standup' }))

    await startBackfill()

    await vi.waitFor(() => {
      const idx = readIndex(getSettings())
      expect(idx.ingested[file]?.ok).toBe(true) // own meeting, bare basename
      expect(idx.ingested[`team/bob/${file}`]?.ok).toBe(true) // team file, namespaced — no collision
    }, { timeout: 10_000 })
    // The own meeting carries no team tag; only the shared-folder file is attributed to bob.
    expect(readMeetingExtraction(getSettings(), extractionSlug(file))?.source_team).toBe('')
    expect(readMeetingExtraction(getSettings(), extractionSlug(`team/bob/${file}`))?.source_team).toBe('bob')
  })

  it('switch-mode devices reuse a shared saved extraction instead of requiring model work for the same sourceVersion', async () => {
    process.env.ASKTOTO_LEDGER_USERDATA = 'switch'
    const file = 'same-meeting.md'
    writeFileSync(join(meetingsFolder, file), '---\ndate: 2026-02-03\n---\nShared meeting text.', 'utf8')
    setSettings({ meetingsFolder })
    await writeMeetingExtraction(getSettings(), extractionSlug(file), MeetingExtractionSchema.parse({ title24: 'Shared meeting' }))
    await writeIndex(getSettings(), BrainIndexSchema.parse({ ingested: { [file]: { at: 1, ok: true, sourceVersion: 'device-one:v1' } } }))

    const deviceTwoUserData = mkdtempSync(join(tmpdir(), 'asktoto-team-device-two-'))
    ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'userData' ? deviceTwoUserData : join(deviceTwoUserData, name)
    )
    try {
      expect((await startBackfill()).queued).toBe(1)
      await vi.waitFor(() => {
        expect(readIndex(getSettings()).ingested[file]?.ok).toBe(true)
      }, { timeout: 10_000 })
    } finally {
      ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
        name === 'userData' ? userData : join(userData, name)
      )
      rmSync(deviceTwoUserData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })

  it('ignores an unavailable team folder without failing the own-meeting scan', async () => {
    writeFileSync(join(meetingsFolder, 'own.md'), '---\ndate: 2026-02-03\n---\nOwn only.', 'utf8')
    setSettings({ meetingsFolder, teamTranscriptFolders: [join(sharedRoot, 'does-not-exist')] })

    // OneDrive can make a shared folder briefly unavailable; the scan must stay safe (no throw).
    await expect(startBackfill()).resolves.toMatchObject({ queued: 0 })
  })

  it('MQA-160 — an edited team transcript that already indexed OK is marked for a clean rebuild', async () => {
    const teamFolder = join(sharedRoot, 'alice')
    mkdirSync(teamFolder)
    const file = 'weekly-sync.md'
    writeFileSync(join(teamFolder, file), '---\ndate: 2026-02-01\n---\nAlice weekly sync notes.', 'utf8')
    setSettings({ meetingsFolder, teamTranscriptFolders: [teamFolder] })
    const key = `team/alice/${file}`
    // Ingested successfully against bytes that no longer match what is on disk — Alice edited her own
    // transcript (a debrief append, a corrected name) and OneDrive synced the change into this brain.
    // Same shape ingest-backfill.test.ts pins for an own meeting; a team file must drift identically.
    await writeIndex(getSettings(), {
      ...readIndex(getSettings()),
      ingested: { [key]: { at: Date.now(), ok: true, sourceVersion: 'stale-version' } }
    } as never)

    expect((await startBackfill()).queued).toBe(0)
    await vi.waitFor(() => {
      expect(readIndex(getSettings()).sourceRefreshRequested).toBe(true)
    }, { timeout: 10_000 })
  })

  it('MQA-160 — an unavailable shared folder is never read as a deleted team transcript', async () => {
    const teamFolder = join(sharedRoot, 'carol')
    setSettings({ meetingsFolder, teamTranscriptFolders: [teamFolder] })
    const key = `team/carol/offsite.md`
    await writeIndex(getSettings(), {
      ...readIndex(getSettings()),
      ingested: { [key]: { at: Date.now(), ok: true, sourceVersion: '1:1' } }
    } as never)

    // Files On-Demand can make the shared folder vanish for a moment; purging the whole brain because
    // of that would be far worse than waiting for it to come back.
    startBackfill()
    await settleBrainWritesForTests()
    expect(readIndex(getSettings()).sourceRefreshRequested).toBeFalsy()
  })
})
