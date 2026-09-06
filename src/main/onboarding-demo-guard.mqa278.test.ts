import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { saveMeeting, saveNote } from './transcripts'
import { enqueueIngest } from './brain/ingest'
import { tagAsDemo } from '@shared/demo-guard'
import type { Settings, SaveMeeting, SaveNote } from '@shared/ipc'

vi.mock('electron')

/**
 * MQA-278 — the Act 2 onboarding demo (a scripted fake meeting shown before the user configures
 * anything, src/renderer/src/lib/onboarding-demo.ts) drives the REAL Bar/Copilot/Answer components with
 * fake data. This proves the belt-and-suspenders half of the safety rule: even if a demo-tagged payload
 * were somehow handed to the real persistence paths, they refuse it before touching disk or the brain.
 * The renderer never actually calls these — see onboarding-demo.mqa277.test.ts's structural contract
 * test — this is the independent, content-based backstop.
 */
describe('MQA-278 — saveMeeting refuses onboarding-demo-tagged data', () => {
  let folder: string
  let settings: Settings

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-demo-guard-meeting-'))
    settings = { meetingsFolder: folder, autoSaveTranscripts: true } as Settings
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  it('rejects a demo-tagged title before writing anything to disk', async () => {
    const meeting: SaveMeeting = {
      title: tagAsDemo('Renewal check-in'),
      mode: 'general',
      startedAt: Date.now(),
      lines: [{ speaker: 'them', text: 'hi', t: Date.now() }],
      recap: ''
    }
    await expect(saveMeeting(settings, meeting)).rejects.toThrow(/demo-guard.*saveMeeting/i)
    expect(readdirSync(folder)).toHaveLength(0) // nothing was written before the throw
  })

  it('rejects a demo-tagged mode too, even with an innocuous title', async () => {
    const meeting: SaveMeeting = {
      title: 'Renewal check-in',
      mode: tagAsDemo('general'),
      startedAt: Date.now(),
      lines: [],
      recap: ''
    }
    await expect(saveMeeting(settings, meeting)).rejects.toThrow(/demo-guard/i)
  })

  it('never blocks a genuine meeting — the guard must not false-positive on real data', async () => {
    const meeting: SaveMeeting = {
      title: 'Quarterly business review',
      mode: 'general',
      startedAt: Date.now(),
      lines: [{ speaker: 'them', text: 'hello', t: Date.now() }],
      recap: ''
    }
    const file = await saveMeeting(settings, meeting)
    expect(existsSync(file)).toBe(true)
  })
})

describe('MQA-278 — saveNote refuses onboarding-demo-tagged data', () => {
  let folder: string
  let settings: Settings

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-demo-guard-note-'))
    settings = { meetingsFolder: folder, autoSaveTranscripts: true } as Settings
  })
  afterEach(() => rmSync(folder, { recursive: true, force: true }))

  it('rejects a demo-tagged note title', async () => {
    const note: SaveNote = { title: tagAsDemo('Fact-check'), mode: 'general', question: 'q', answer: 'a' }
    await expect(saveNote(settings, note)).rejects.toThrow(/demo-guard.*saveNote/i)
    expect(readdirSync(folder)).toHaveLength(0)
  })

  it('rejects a demo-tagged question even with a clean title/mode', async () => {
    const note: SaveNote = { title: 'Fact-check', mode: 'general', question: tagAsDemo('claim'), answer: 'a' }
    await expect(saveNote(settings, note)).rejects.toThrow(/demo-guard/i)
  })

  it('never blocks a genuine note', async () => {
    const note: SaveNote = { title: 'Real note', mode: 'general', question: 'q', answer: 'a' }
    const file = await saveNote(settings, note)
    expect(existsSync(file)).toBe(true)
  })
})

describe('MQA-278 — enqueueIngest refuses an onboarding-demo-tagged file before touching the brain', () => {
  it('rejects a demo-tagged filename synchronously — before any settings/index access', async () => {
    const taggedPath = join('/tmp', `${tagAsDemo('fake-meeting')}.md`)
    await expect(enqueueIngest(taggedPath)).rejects.toThrow(/demo-guard.*enqueueIngest/i)
  })
})
