import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { saveMeeting, saveDraftTranscript } from './transcripts'
import type { SaveMeeting, Settings } from '@shared/ipc'

vi.mock('electron')

describe('enterprise-live summary-only saveMeeting', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metis-sumonly-'))
    vi.mocked(app.getPath).mockReturnValue(dir)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const meeting = (): SaveMeeting => ({
    title: 'Region review',
    mode: 'general',
    startedAt: Date.parse('2026-09-13T20:00:00Z'),
    durationMs: 60000,
    lines: [
      {
        speaker: 'them',
        text: 'SECRET_VERBATIM_SHOULD_NOT_PERSIST',
        t: Date.parse('2026-09-13T20:00:01Z'),
        name: 'Ada'
      }
    ],
    recap: '## Summary\n\nConfirm the processing region.\n\n## Actions\n\n- [ ] Confirm region',
    recapStatus: 'complete'
  })

  it('omits Full transcript for managed summaryOnly without deleting legacy behavior', async () => {
    const settings = {
      meetingsFolder: dir,
      autoSaveTranscripts: true,
      encryptTranscripts: false,
      enterpriseLive: { managed: true, inferenceMode: 'cloud-only', summaryOnly: true }
    } as Settings
    const file = await saveMeeting(settings, meeting())
    const md = readFileSync(file, 'utf8')
    expect(md).toContain('retention: summary-only')
    expect(md).toContain('type: meeting-summary')
    expect(md).toContain('## Retention')
    expect(md).not.toContain('## Full transcript')
    expect(md).not.toContain('SECRET_VERBATIM_SHOULD_NOT_PERSIST')
    expect(md).toContain('Confirm the processing region')
  })

  it('still writes Full transcript when profile is legacy', async () => {
    const settings = {
      meetingsFolder: dir,
      autoSaveTranscripts: true,
      encryptTranscripts: false,
      enterpriseLive: { managed: false, inferenceMode: 'legacy', summaryOnly: false }
    } as Settings
    const file = await saveMeeting(settings, meeting())
    const md = readFileSync(file, 'utf8')
    expect(md).toContain('## Full transcript')
    expect(md).toContain('SECRET_VERBATIM_SHOULD_NOT_PERSIST')
    expect(md).not.toContain('retention: summary-only')
  })

  it.each([
    false,
    true
  ])('does not create a summary-only autosave folder with encryption=%s', async (encryptTranscripts) => {
    const folder = join(dir, 'fresh-meeting-folder')
    const settings = {
      meetingsFolder: folder,
      autoSaveTranscripts: true,
      encryptTranscripts,
      enterpriseLive: { managed: true, inferenceMode: 'cloud-only', summaryOnly: true }
    } as Settings

    await saveDraftTranscript(settings, meeting())

    expect(existsSync(folder)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('does not overwrite or delete an earlier permitted draft under summary-only', async () => {
    const settings = {
      meetingsFolder: dir,
      autoSaveTranscripts: true,
      encryptTranscripts: false,
      enterpriseLive: { managed: false, inferenceMode: 'legacy', summaryOnly: false }
    } as Settings
    await saveDraftTranscript(settings, meeting())
    const before = readdirSync(dir).sort()
    const drafts = before.filter((name) => /^\.autosave-draft-.*\.md$/.test(name))
    expect(drafts).toHaveLength(1)
    const draft = join(dir, drafts[0])
    const original = readFileSync(draft)
    expect(original.toString('utf8')).toContain('SECRET_VERBATIM_SHOULD_NOT_PERSIST')
    const olderFile = join(dir, 'previous-meeting.md')
    writeFileSync(olderFile, 'SYNTHETIC_PREVIOUS_MEETING_SENTINEL')

    await saveDraftTranscript(
      {
        ...settings,
        enterpriseLive: { managed: true, inferenceMode: 'cloud-only', summaryOnly: true }
      },
      { ...meeting(), lines: [{ speaker: 'you', text: 'SYNTHETIC_NEW_PRIVATE_SPEECH', t: meeting().startedAt }] }
    )

    expect(readdirSync(dir).sort()).toEqual([...before, 'previous-meeting.md'].sort())
    expect(readFileSync(draft)).toEqual(original)
    expect(readFileSync(olderFile, 'utf8')).toBe('SYNTHETIC_PREVIOUS_MEETING_SENTINEL')
  })
})
