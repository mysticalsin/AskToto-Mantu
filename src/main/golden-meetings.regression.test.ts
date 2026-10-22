/**
 * GATE-05 / R112 regression fixtures: save -> recap/summary -> exports (plain, JSON, HTML for the PDF) -> reopen.
 *
 * Synthetic meetings only (src/main/__fixtures__/golden-meetings.ts). Every step runs the real production
 * function against a throwaway meetings folder: saveMeeting, listMeetings, searchMeetings, recallRead,
 * updateMeetingRecap, readSavedMeeting (History "Export copy"), parseRecapMarkdown (the JSON export handler's
 * transform) and recapMarkdownToHtml (the document printToPDF renders). Printing the PDF itself needs a live
 * Electron window and stays outside a unit fixture; its input, the HTML, is pinned here.
 *
 * What the fixtures hold fixed: the structure each step returns, and that no content is lost or duplicated on
 * the way (each fact appears exactly once in the saved file, the reopened meeting and the plain export).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { safeStorage } from 'electron'
import { RecapExportSchema, type RecapExport, type SaveMeeting, type Settings } from '@shared/ipc'
import { parseRecapMarkdown, recapMarkdownToHtml, saveMeeting, isEncryptedFile } from './transcripts'
import { listMeetings, recallRead, searchMeetings, updateMeetingRecap, deleteMeeting } from './recall'
import { readSavedMeeting } from './history-actions'
import { useStorageForTests } from './infra/storage/meetings-storage'
import {
  ALPHA,
  FRENCH,
  GOLDEN_MEETINGS,
  NOTES_ONLY,
  occurrences,
  type GoldenMeeting
} from './__fixtures__/golden-meetings'

vi.mock('electron')

let testSettings: Settings
vi.mock('./store', () => ({ getSettings: () => testSettings }))

let folder: string

function useFolder(overrides: Partial<Settings> = {}): void {
  useStorageForTests()
  // realpath: on Windows CI tmpdir is a short 8.3 name and the gateway compares resolved paths.
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'metis-golden-')))
  testSettings = { meetingsFolder: folder, encryptTranscripts: false, ...overrides } as Settings
}

beforeEach(() => useFolder())

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function saveGolden(g: GoldenMeeting): Promise<{ path: string; file: string }> {
  const path = await saveMeeting(testSettings, g.meeting)
  return { path, file: basename(path) }
}

function linesOf(read: Awaited<ReturnType<typeof recallRead>>): { speaker: string; text: string }[] {
  if (!read.ok || !read.lines) throw new Error('read returned no lines')
  return read.lines.map((l) => ({ speaker: l.speaker, text: l.text }))
}

/** A recap that still has its recap text but not the saved-meeting wrapper, as Review holds it. */
function openedRecap(read: Awaited<ReturnType<typeof recallRead>>): string {
  if (!read.ok) throw new Error(`reopen failed: ${read.error}`)
  return read.recap ?? ''
}

describe.each(GOLDEN_MEETINGS.map((g) => [g.id, g] as const))('golden meeting: %s', (_id, g) => {
  it('save -> reopen returns the same recap, the same lines, once each', async () => {
    const { file, path } = await saveGolden(g)
    const reopened = await recallRead(file)

    expect(reopened).toMatchObject({ ok: true, mode: g.meeting.mode, startedAt: g.meeting.startedAt })
    expect(openedRecap(reopened)).toBe(g.meeting.recap.trim())
    expect(linesOf(reopened)).toEqual(g.meeting.lines.map((l) => ({ speaker: l.speaker, text: l.text })))

    // Nothing duplicated on disk: each spoken line and the recap body appear exactly once in the saved file.
    const onDisk = readFileSync(path, 'utf8')
    for (const l of g.meeting.lines) expect(occurrences(onDisk, l.text)).toBe(1)
    if (g.meeting.recap.trim()) expect(occurrences(onDisk, g.meeting.recap.trim())).toBe(1)
    expect(occurrences(onDisk, '## Full transcript')).toBe(1)
    // A meeting saved before any recap has no notes section yet; the first edit below adds exactly one.
    expect(occurrences(onDisk, '## Notes & follow-ups')).toBe(g.meeting.recap.trim() ? 1 : 0)
  })

  it('lists one row with the recap-derived title and tags, and search finds it by body text', async () => {
    const { file } = await saveGolden(g)
    const rows = await listMeetings()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ file, mode: g.meeting.mode })
    expect(rows[0].date).toBe(new Date(g.meeting.startedAt).toISOString())
    expect(rows[0].title).toBe(g.expectedExport.title24 || g.meeting.title)
    if (g.expectedExport.tags.length) expect(rows[0].topics).toEqual(g.expectedExport.tags)
    else expect(rows[0].topics).toBeUndefined()
    expect(rows[0].participants).toEqual(['Them', 'You'])

    const found = await searchMeetings(g.searchTerm)
    expect(found.total).toBe(1)
    expect(found.hits.map((h) => h.file)).toEqual([file])
    expect(found.hits[0].snippet.toLowerCase()).toContain(g.searchTerm)
  })

  it('JSON export keeps the golden structure and the full markdown, and round-trips through its schema', async () => {
    const { file } = await saveGolden(g)
    const recap = openedRecap(await recallRead(file))
    const exported = parseRecapMarkdown(recap)

    expect(exported).toEqual({ ...g.expectedExport, markdown: recap })
    expect(RecapExportSchema.safeParse(exported).success).toBe(true)
    const roundTripped = JSON.parse(JSON.stringify(exported, null, 2)) as RecapExport
    expect(roundTripped).toEqual(exported)
    // No decision or action is dropped or doubled between the recap and the export.
    expect(exported.decisions).toHaveLength(g.expectedExport.decisions.length)
    expect(exported.actionItems).toHaveLength(g.expectedExport.actionItems.length)
    expect(new Set(exported.decisions).size).toBe(exported.decisions.length)
  })

  it('HTML (the PDF source) has one heading per section and one list item per bullet, with each fact once', async () => {
    const { file } = await saveGolden(g)
    const recap = openedRecap(await recallRead(file))
    const html = recapMarkdownToHtml(recap, g.expectedExport.title24 || g.meeting.title)

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain("script-src 'none'")
    expect(html).not.toMatch(/<script/i)
    expect(occurrences(html, '<h1>')).toBe(1)
    expect(occurrences(html, '<h2>')).toBe((recap.match(/^##\s+/gm) ?? []).length)
    expect(occurrences(html, '<li>')).toBe((recap.match(/^\s*[-*]\s+/gm) ?? []).length)
    const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    for (const decision of g.expectedExport.decisions) expect(occurrences(html, escape(decision))).toBe(1)
    for (const item of g.expectedExport.actionItems) expect(occurrences(html, escape(item.text))).toBe(1)
    // Balanced structure: every opened list and item closes.
    expect(occurrences(html, '<ul>') + occurrences(html, '<ol>')).toBe(
      occurrences(html, '</ul>') + occurrences(html, '</ol>')
    )
    expect(occurrences(html, '<li>')).toBe(occurrences(html, '</li>'))
  })

  it('plain export decodes the whole saved meeting with every fact exactly once', async () => {
    const { file, path } = await saveGolden(g)
    const text = await readSavedMeeting(folder, file)

    expect(text).toBe(readFileSync(path, 'utf8')) // plaintext profile: the export is the file, byte for byte
    expect(text).toMatch(/^---\r?\n/)
    expect(text).toContain('type: meeting-transcript')
    for (const fact of g.uniqueFacts) expect(occurrences(text, fact)).toBe(1)
  })

  it('an edited recap reopens as the edit, keeps the transcript intact and never stacks a second recap', async () => {
    const { file, path } = await saveGolden(g)
    const edited = [
      '## Overview',
      'Edited by the user, synthetic.',
      '## Decisions',
      '- Keep <script>alert(1)</script> out of the PDF',
      '## Action items',
      '- Replace the placeholder (Dana)'
    ].join('\n')

    await expect(updateMeetingRecap(testSettings, file, edited)).resolves.toEqual({ ok: true })
    // Saving the same edit again changes nothing (idempotent), and still leaves one recap section.
    const afterFirst = readFileSync(path, 'utf8')
    await expect(updateMeetingRecap(testSettings, file, edited)).resolves.toEqual({ ok: true })
    expect(readFileSync(path, 'utf8')).toBe(afterFirst)

    const reopened = await recallRead(file)
    expect(openedRecap(reopened)).toBe(edited)
    expect(linesOf(reopened)).toEqual(g.meeting.lines.map((l) => ({ speaker: l.speaker, text: l.text })))
    expect(reopened).toMatchObject({ ok: true, recapEdited: true })

    const onDisk = readFileSync(path, 'utf8')
    expect(occurrences(onDisk, '## Notes & follow-ups')).toBe(1)
    expect(occurrences(onDisk, '## Full transcript')).toBe(1)
    if (g.meeting.recap.trim()) expect(occurrences(onDisk, g.meeting.recap.trim())).toBe(0)
    for (const fact of g.uniqueFacts.filter((f) => g.meeting.lines.some((l) => l.text === f)))
      expect(occurrences(onDisk, fact)).toBe(1)

    const exported = parseRecapMarkdown(openedRecap(reopened))
    expect(exported.decisions).toEqual(['Keep <script>alert(1)</script> out of the PDF'])
    expect(exported.actionItems).toEqual([{ text: 'Replace the placeholder', owner: 'Dana', dueDateText: null }])
    const html = recapMarkdownToHtml(edited, 'Edited')
    expect(html).not.toMatch(/<script>alert/i)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
})

describe('golden library: every meeting together', () => {
  it('lists newest first, searches without cross-talk, and re-saving one start time keeps both files', async () => {
    const saved: Record<string, string> = {}
    for (const g of GOLDEN_MEETINGS) saved[g.id] = (await saveGolden(g)).file

    const rows = await listMeetings()
    expect(rows.map((r) => r.file)).toEqual([saved[NOTES_ONLY.id], saved[FRENCH.id], saved[ALPHA.id]])

    for (const g of GOLDEN_MEETINGS) {
      const found = await searchMeetings(g.searchTerm)
      expect(found.hits.map((h) => h.file)).toEqual([saved[g.id]])
    }

    // Saving the same meeting again must never overwrite: both copies stay, the second under a suffix.
    const again = await saveGolden(ALPHA)
    expect(again.file).not.toBe(saved[ALPHA.id])
    const after = await listMeetings()
    expect(after).toHaveLength(4)
    expect((await searchMeetings('orchid')).total).toBe(2)
    for (const g of GOLDEN_MEETINGS) expect(openedRecap(await recallRead(saved[g.id]))).toBe(g.meeting.recap.trim())

    // Deleting one meeting leaves every other reopenable and listed.
    await expect(deleteMeeting(saved[FRENCH.id])).resolves.toMatchObject({ ok: true })
    expect((await listMeetings()).map((r) => r.file).sort()).toEqual(
      [saved[NOTES_ONLY.id], saved[ALPHA.id], again.file].sort()
    )
    expect(openedRecap(await recallRead(saved[ALPHA.id]))).toBe(ALPHA.meeting.recap.trim())
  })
})

describe('golden meeting encrypted at rest', () => {
  beforeEach(() => {
    rmSync(folder, { recursive: true, force: true })
    useFolder({ encryptTranscripts: true })
    vi.spyOn(safeStorage, 'encryptString').mockImplementation((v: string) =>
      Buffer.from('B64:' + Buffer.from(v, 'utf8').toString('base64'))
    )
    vi.spyOn(safeStorage, 'decryptString').mockImplementation((b: Buffer) => {
      const s = b.toString('utf8')
      return s.startsWith('B64:') ? Buffer.from(s.slice(4), 'base64').toString('utf8') : s
    })
  })

  it.each(
    GOLDEN_MEETINGS.map((g) => [g.id, g] as const)
  )('%s: list, search, reopen and plain export all see the plaintext, the file does not', async (_id, g) => {
    const { file, path } = await saveGolden(g)
    expect(isEncryptedFile(path)).toBe(true)
    expect(readFileSync(path).includes(Buffer.from(g.meeting.lines[0].text))).toBe(false)

    expect((await listMeetings()).map((r) => r.file)).toEqual([file])
    expect((await searchMeetings(g.searchTerm)).hits.map((h) => h.file)).toEqual([file])
    const reopened = await recallRead(file)
    expect(openedRecap(reopened)).toBe(g.meeting.recap.trim())
    expect(linesOf(reopened)).toEqual(g.meeting.lines.map((l) => ({ speaker: l.speaker, text: l.text })))
    const text = await readSavedMeeting(folder, file)
    for (const fact of g.uniqueFacts) expect(occurrences(text, fact)).toBe(1)
    expect(parseRecapMarkdown(openedRecap(reopened))).toEqual({ ...g.expectedExport, markdown: g.meeting.recap.trim() })
  })

  it('an edit keeps the file encrypted and the reopened recap is the edit', async () => {
    const { file, path } = await saveGolden(ALPHA)
    await expect(updateMeetingRecap(testSettings, file, '## Overview\nEncrypted edit, synthetic.')).resolves.toEqual({
      ok: true
    })
    expect(isEncryptedFile(path)).toBe(true)
    expect(openedRecap(await recallRead(file))).toBe('## Overview\nEncrypted edit, synthetic.')
  })
})

describe('golden summary-only meeting (managed retention)', () => {
  it('keeps the summary through list, search, reopen and plain export with no transcript lines', async () => {
    rmSync(folder, { recursive: true, force: true })
    useFolder({
      enterpriseLive: { managed: true, inferenceMode: 'cloud-only', summaryOnly: true }
    } as Partial<Settings>)
    const meeting: SaveMeeting = { ...ALPHA.meeting }
    const path = await saveMeeting(testSettings, meeting)
    const name = basename(path)

    const onDisk = readFileSync(path, 'utf8')
    for (const l of meeting.lines) expect(onDisk).not.toContain(l.text)
    expect((await listMeetings()).map((r) => r.file)).toEqual([name])
    expect((await searchMeetings('orchid')).hits.map((h) => h.file)).toEqual([name])
    const reopened = await recallRead(name)
    expect(openedRecap(reopened)).toBe(ALPHA.meeting.recap.trim())
    expect(linesOf(reopened)).toEqual([])
    const text = await readSavedMeeting(folder, name)
    expect(occurrences(text, 'Ship the pilot to the synthetic Orchid cohort first')).toBe(1)
    expect(parseRecapMarkdown(openedRecap(reopened))).toEqual({
      ...ALPHA.expectedExport,
      markdown: ALPHA.meeting.recap.trim()
    })
  })
})
