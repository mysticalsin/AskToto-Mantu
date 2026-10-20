import { existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRelaunchHarness, KILL_STAGES, readRaw, type RelaunchHarness } from '../../test-helpers/relaunch-harness'

vi.mock('electron')
const unlinkFault = vi.hoisted(() => ({ path: '' }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (String(args[0]) === unlinkFault.path) throw Object.assign(new Error('busy draft'), { code: 'EBUSY' })
      return actual.unlink(...args)
    }
  }
})

let nextStartedAt = 1_700_000_200_123
let harness: RelaunchHarness | undefined

const start = async (): Promise<RelaunchHarness> => {
  expect(vi.isFakeTimers()).toBe(false)
  harness = await createRelaunchHarness(nextStartedAt)
  nextStartedAt += 1_000
  return harness
}

afterEach(async () => {
  unlinkFault.path = ''
  await harness?.dispose()
  harness = undefined
})

describe('meeting recovery across a relaunch (GATE-07)', () => {
  it('keeps a saved meeting unique when its stale draft cannot be deleted, while recovering other orphans', async () => {
    const h = await start()
    await h.runUntilKilled('after-saved-written')
    const orphan = await createRelaunchHarness(h.meeting.startedAt + 1000, h.folder)
    await orphan.runUntilKilled('after-draft-sealed')
    const [saved] = await h.meetings()
    const before = await readRaw(h.folder, saved.name)
    const stale = (await h.drafts()).sort()[0]
    unlinkFault.path = join(h.folder, stale)
    await expect(h.relaunch()).resolves.toEqual({ recovered: 1 })
    expect(await h.meetings()).toHaveLength(1)
    expect(await orphan.meetings()).toHaveLength(1)
    expect(await h.drafts()).toEqual([stale])
    await expect(h.relaunch()).resolves.toEqual({ recovered: 0 })
    expect(await h.meetings()).toHaveLength(1)
    unlinkFault.path = ''
    await expect(h.relaunch()).resolves.toEqual({ recovered: 0 })
    expect(await h.drafts()).toEqual([])
    expect((await readRaw(h.folder, saved.name)).equals(before)).toBe(true)
  })
  it.each(KILL_STAGES)('kill at each stage then relaunch yields exactly one meeting (%s)', async (killAt) => {
    const h = await start()
    await h.runUntilKilled(killAt)
    await h.relaunch()
    expect(await h.meetings()).toHaveLength(1)
    expect(await h.drafts()).toEqual([])
    // A second relaunch changes nothing.
    await expect(h.relaunch()).resolves.toEqual({ recovered: 0 })
    expect(await h.meetings()).toHaveLength(1)
  })

  it('a meeting whose pipeline completed stays exactly one meeting across a relaunch', async () => {
    const h = await start()
    await h.runUntilKilled('never')
    expect(await h.drafts()).toEqual([])
    await expect(h.relaunch()).resolves.toEqual({ recovered: 0 })
    const meetings = await h.meetings()
    expect(meetings).toHaveLength(1)
    expect(meetings[0].name).not.toMatch(/-recovered/)
  })

  it('relaunch resumes the incomplete draft cleanup without repeating the completed save', async () => {
    const h = await start()
    await h.runUntilKilled('after-saved-written')
    expect(h.completed).toEqual(['draft-autosaved', 'draft-sealed', 'saved-written'])
    const [saved] = await h.meetings()
    const before = await readRaw(h.folder, saved.name)
    const mtime = statSync(join(h.folder, saved.name)).mtimeMs
    expect(await h.drafts()).toHaveLength(1)
    await expect(h.relaunch()).resolves.toEqual({ recovered: 0 })
    expect(await h.drafts()).toEqual([])
    const after = await h.meetings()
    expect(after.map((m) => m.name)).toEqual([saved.name])
    expect((await readRaw(h.folder, saved.name)).equals(before)).toBe(true)
    expect(statSync(join(h.folder, saved.name)).mtimeMs).toBe(mtime)
    expect(after[0].fields.status).not.toBe('recovered')
  })

  it('recovered meeting carries status recovered and latest checkpoint revision', async () => {
    const h = await start()
    const revision = await h.runUntilKilled('after-draft-sealed')
    await expect(h.relaunch()).resolves.toEqual({ recovered: 1 })
    const [recovered] = await h.meetings()
    expect(recovered.name).toMatch(/-recovered\.md$/)
    expect(recovered.fields.type).toBe('meeting-transcript')
    expect(recovered.fields.status).toBe('recovered')
    expect(recovered.fields.transcriptRevision).toBe(String(revision))
    expect(recovered.fields.revisionSchema).toBe('1')
    expect(recovered.fields.segmentLanguages).toBe('en-US@0 fr@1')
    expect(recovered.text).toContain('Shall we ship on Friday?')
  })

  it('a crashed meeting that started in the same second as a saved one is still recovered', async () => {
    const saved = await start()
    // Same wall-clock second, different millisecond: the filename stamp matches, the identity does not.
    const crashed = await createRelaunchHarness(saved.meeting.startedAt + 1, saved.folder)
    await saved.runUntilKilled('mid-unlink')
    await crashed.runUntilKilled('after-draft-sealed')
    await expect(saved.relaunch()).resolves.toEqual({ recovered: 1 })
    expect(await saved.meetings()).toHaveLength(1)
    const recovered = await crashed.meetings()
    expect(recovered).toHaveLength(1)
    expect(recovered[0].fields.status).toBe('recovered')
    expect(await saved.drafts()).toEqual([])
  })

  it('a non-meeting file with the same identity never removes a crashed draft', async () => {
    const h = await start()
    await h.runUntilKilled('after-draft-sealed')
    const [draft] = await h.drafts()
    const stampPart = draft.slice('.autosave-draft-'.length, -'-000.md'.length)
    const iso = new Date(h.meeting.startedAt).toISOString()
    const note = join(h.folder, `${stampPart}-note.md`)
    writeFileSync(note, `---\ntype: note\ndate: ${iso}\n---\n\nA note.\n`)
    await expect(h.relaunch()).resolves.toEqual({ recovered: 1 })
    expect(existsSync(note)).toBe(true)
    const [recovered] = await h.meetings()
    expect(recovered.fields.status).toBe('recovered')
  })

  it('a saved meeting carries the latest checkpoint revision after a relaunch', async () => {
    const h = await start()
    const revision = await h.runUntilKilled('after-ingest-queued')
    await h.relaunch()
    const [saved] = await h.meetings()
    expect(saved.fields.transcriptRevision).toBe(String(revision))
    expect(saved.fields.segmentLanguages).toBe('en-US@0 fr@1')
  })
})
