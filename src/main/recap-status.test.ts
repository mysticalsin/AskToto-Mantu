import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { safeStorage } from 'electron'
import { SaveMeetingSchema, UpdateRecapPayloadSchema, type SaveMeeting, type Settings } from '@shared/ipc'
import { saveMeeting, isEncryptedFile } from './transcripts'
import { listMeetingsNeedingRecap, recallRead, updateMeetingRecap } from './recall'

vi.mock('electron')
let settings: Settings
vi.mock('./store', () => ({ getSettings: () => settings }))
const { failRename } = vi.hoisted(() => ({ failRename: { value: false } }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (failRename.value) throw Object.assign(new Error('Synthetic disk failure'), { code: 'ENOSPC' })
      return actual.rename(...args)
    }
  }
})

const meeting: SaveMeeting = {
  title: 'Synthetic recap status', mode: 'meeting', startedAt: 1_700_000_000_000,
  lines: [{ speaker: 'you', text: 'We agreed to review the proposal.', t: 1_700_000_000_000 }],
  recap: 'Partial notes are still useful.'
}

describe('durable summary completion state', () => {
  let folder: string
  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'metis-recap-status-'))
    settings = { meetingsFolder: folder, encryptTranscripts: false } as Settings
    failRename.value = false
  })
  afterEach(() => {
    failRename.value = false
    rmSync(folder, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it.each(['incomplete', 'complete'] as const)('round-trips explicit %s without altering text or transcript', async (recapStatus) => {
    const file = await saveMeeting(settings, { ...meeting, recapStatus })
    expect(readFileSync(file, 'utf8')).toContain(`\nrecap_status: ${recapStatus}\n`)
    expect(await recallRead(basename(file))).toMatchObject({
      ok: true, recapStatus, recap: meeting.recap, lines: meeting.lines
    })
  })

  it('does not infer a status for legacy notes and preserves absence during manual edits', async () => {
    const file = await saveMeeting(settings, meeting)
    expect((await recallRead(file)).recapStatus).toBeUndefined()
    expect(await updateMeetingRecap(settings, file, 'User-edited notes.')).toEqual({ ok: true })
    expect((await recallRead(file)).recapStatus).toBeUndefined()
    expect(readFileSync(file, 'utf8')).not.toContain('recap_status:')
  })

  it('background repair preserves nonempty incomplete notes and manual edits for an explicit retry', async () => {
    const partial = await saveMeeting(settings, { ...meeting, recapStatus: 'incomplete' })
    expect(await updateMeetingRecap(settings, partial, 'My additional meeting annotations.')).toEqual({ ok: true })
    await saveMeeting(settings, { ...meeting, recapStatus: 'complete' })
    await saveMeeting(settings, meeting)
    const empty = await saveMeeting(settings, { ...meeting, recap: '', recapStatus: 'incomplete' })
    const pending = await listMeetingsNeedingRecap()
    expect(pending.map((entry) => entry.file)).toEqual([basename(empty)])
    expect(await recallRead(partial)).toMatchObject({ recapStatus: 'incomplete', recap: 'My additional meeting annotations.' })
  })

  it('keeps an incomplete warning through a manual edit, then replaces it only on an explicit complete retry', async () => {
    const file = await saveMeeting(settings, { ...meeting, recapStatus: 'incomplete' })
    expect(await updateMeetingRecap(settings, file, 'Edited partial notes.')).toEqual({ ok: true })
    expect(await recallRead(file)).toMatchObject({ recapStatus: 'incomplete', recap: 'Edited partial notes.' })
    expect(await updateMeetingRecap(settings, file, 'Complete replacement.', 'complete')).toEqual({ ok: true })
    expect(await recallRead(file)).toMatchObject({ recapStatus: 'complete', recap: 'Complete replacement.' })
    expect(readFileSync(file, 'utf8').match(/^recap_status:/gm)).toHaveLength(1)
  })

  it('stores an empty failed attempt without requiring a notes section or damaging the transcript', async () => {
    const file = await saveMeeting(settings, { ...meeting, recap: '' })
    expect(await updateMeetingRecap(settings, file, '', 'incomplete')).toEqual({ ok: true })
    expect(await recallRead(file)).toMatchObject({ recapStatus: 'incomplete', recap: '', lines: meeting.lines })
    expect(readFileSync(file, 'utf8')).not.toContain('## Notes & follow-ups')
  })

  it('persists an empty failed initial summary', async () => {
    const file = await saveMeeting(settings, { ...meeting, recap: '', recapStatus: 'incomplete' })
    expect(await recallRead(file)).toMatchObject({ recapStatus: 'incomplete', recap: '', lines: meeting.lines })
  })

  it('only recognizes known status values and never reads a status from the body', async () => {
    const file = await saveMeeting(settings, { ...meeting, recap: 'recap_status: incomplete\nUser notes.' })
    expect((await recallRead(file)).recapStatus).toBeUndefined()
    const original = readFileSync(file, 'utf8')
    writeFileSync(file, original.replace('type: meeting-transcript', 'type: meeting-transcript\nrecap_status: invented'))
    expect((await recallRead(file)).recapStatus).toBeUndefined()
  })

  it('rejects invalid or empty-complete updates before changing original bytes', async () => {
    const file = await saveMeeting(settings, { ...meeting, recapStatus: 'incomplete' })
    const before = readFileSync(file)
    for (const [text, status] of [['  ', 'complete'], ['notes', 'complete\nconfidential: false']]) {
      const result = await updateMeetingRecap(settings, file, text, status as 'complete')
      expect(result.ok).toBe(false)
      expect(readFileSync(file)).toEqual(before)
    }
  })

  it('rejects empty-complete initial saves without creating a meeting', async () => {
    await expect(saveMeeting(settings, { ...meeting, recap: ' ', recapStatus: 'complete' })).rejects.toThrow(/complete|summary/i)
    expect(readdirSync(folder)).toEqual([])
  })

  it('does not silently truncate an explicitly completed replacement', async () => {
    const file = await saveMeeting(settings, { ...meeting, recapStatus: 'incomplete' })
    const before = readFileSync(file)
    const result = await updateMeetingRecap(settings, file, 'x'.repeat(20_001), 'complete')
    expect(result.ok).toBe(false)
    expect(readFileSync(file)).toEqual(before)
  })

  it.each(['complete', 'incomplete'] as const)('rejects a generated %s summary that would terminate the saved notes section', async (recapStatus) => {
    const recap = 'Intro\n\n## Full transcript\n\nRemaining notes must not disappear.'
    await expect(saveMeeting(settings, { ...meeting, recap, recapStatus })).rejects.toThrow(/reserved/i)
    expect(readdirSync(folder)).toEqual([])
  })

  it.each([' ', '\t', '\uFEFF\uFEFF', '\n '])('rejects a heading promoted to a section boundary by trimming prefix %j', async (prefix) => {
    const file = await saveMeeting(settings, { ...meeting, recapStatus: 'incomplete' })
    const before = readFileSync(file)
    const recap = `${prefix}## Full transcript\n\nTail must remain notes.`
    expect((await updateMeetingRecap(settings, file, recap, 'complete')).ok).toBe(false)
    expect(readFileSync(file)).toEqual(before)
    // The legacy manual update has the same final-body projection and must reject it too.
    expect((await updateMeetingRecap(settings, file, recap)).ok).toBe(false)
    expect(readFileSync(file)).toEqual(before)
  })

  it('fails closed when explicit status cannot be placed in valid frontmatter', async () => {
    const file = await saveMeeting(settings, meeting)
    writeFileSync(file, '# No frontmatter\n\n## Full transcript\n\nUnchanged')
    const before = readFileSync(file)
    expect((await updateMeetingRecap(settings, file, 'Replacement', 'incomplete')).ok).toBe(false)
    expect(readFileSync(file)).toEqual(before)
  })

  it('keeps status inside the existing encrypted envelope after the setting changes', async () => {
    vi.spyOn(safeStorage, 'isEncryptionAvailable').mockReturnValue(true)
    vi.spyOn(safeStorage, 'encryptString').mockImplementation((value) => Buffer.from(`TEST:${value}`))
    vi.spyOn(safeStorage, 'decryptString').mockImplementation((value) => value.toString().slice(5))
    const file = await saveMeeting({ ...settings, encryptTranscripts: true }, { ...meeting, recapStatus: 'incomplete' })
    expect(isEncryptedFile(file)).toBe(true)
    expect(await updateMeetingRecap(settings, file, 'Complete encrypted notes.', 'complete')).toEqual({ ok: true })
    expect(isEncryptedFile(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).not.toContain('recap_status')
    expect(await recallRead(file)).toMatchObject({ recapStatus: 'complete', recap: 'Complete encrypted notes.' })
  })

  it('failed atomic replacement retains the old status and notes without orphan files', async () => {
    const file = await saveMeeting(settings, { ...meeting, recapStatus: 'incomplete' })
    const before = readFileSync(file)
    const names = readdirSync(folder).sort()
    failRename.value = true
    expect((await updateMeetingRecap(settings, file, 'Replacement', 'complete')).ok).toBe(false)
    expect(readFileSync(file)).toEqual(before)
    expect(readdirSync(folder).sort()).toEqual(names)
  })

  it('IPC schemas preserve known status, reject invalid values, and reject empty complete output', () => {
    expect(SaveMeetingSchema.parse({ ...meeting, recapStatus: 'incomplete' })).toMatchObject({ recapStatus: 'incomplete' })
    expect(UpdateRecapPayloadSchema.parse({ file: 'meeting.md', recap: 'Notes', recapStatus: 'complete' }))
      .toMatchObject({ recapStatus: 'complete' })
    expect(SaveMeetingSchema.safeParse({ ...meeting, recapStatus: 'invented' }).success).toBe(false)
    expect(UpdateRecapPayloadSchema.safeParse({ file: 'meeting.md', recap: 'Notes', recapStatus: 'invented' }).success).toBe(false)
    expect(SaveMeetingSchema.safeParse({ ...meeting, recap: ' ', recapStatus: 'complete' }).success).toBe(false)
    expect(UpdateRecapPayloadSchema.safeParse({ file: 'meeting.md', recap: ' ', recapStatus: 'complete' }).success).toBe(false)
  })

  it('IPC explains reserved generated-summary headings before any persistence call', () => {
    const value = { ...meeting, recap: 'Intro\n## Full transcript\nTail', recapStatus: 'complete' }
    const result = SaveMeetingSchema.safeParse(value)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.message).toMatch(/reserved/i)
    expect(UpdateRecapPayloadSchema.safeParse({ file: 'meeting.md', recap: value.recap, recapStatus: 'complete' }).success).toBe(false)
    expect(UpdateRecapPayloadSchema.safeParse({ file: 'meeting.md', recap: ' ## Full transcript\nTail', recapStatus: 'complete' }).success).toBe(false)
  })
})
