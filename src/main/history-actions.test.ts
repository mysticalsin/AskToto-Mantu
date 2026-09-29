import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { app, safeStorage } from 'electron'
import type { SaveMeeting, Settings } from '@shared/ipc'
import { createFifo, releaseFifo } from '../../scripts/qa/fixtures/fifo.mjs'
import { saveMeeting } from './transcripts'
import { useStorageForTests } from './infra/storage/meetings-storage'
import type { ContentPresence, DatalessDetector } from './infra/storage/dataless'
import { MEETING_NOT_READABLE_MSG, meetingOpenTarget, readSavedMeeting } from './history-actions'

vi.mock('electron')

const NAME = '2026-01-01_090000-weekly-sync.md'

const everyFile = (presence: ContentPresence): DatalessDetector => ({
  classify: async (files) => new Map(files.map((file): [string, ContentPresence] => [file.path, presence]))
})

let folder: string
let tempDir: string

beforeEach(() => {
  useStorageForTests()
  // realpath: on Windows CI tmpdir is a short 8.3 name and the gateway compares resolved paths.
  folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'history-actions-')))
  tempDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'history-actions-temp-')))
  ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => (name === 'temp' ? tempDir : join(tempDir, name)))
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
  rmSync(tempDir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function saveEncryptedMeeting(): Promise<string> {
  vi.spyOn(safeStorage, 'encryptString').mockImplementation((v: string) =>
    Buffer.from('B64:' + Buffer.from(v, 'utf8').toString('base64'))
  )
  vi.spyOn(safeStorage, 'decryptString').mockImplementation((b: Buffer) => {
    const s = b.toString('utf8')
    return s.startsWith('B64:') ? Buffer.from(s.slice(4), 'base64').toString('utf8') : s
  })
  const settings = { meetingsFolder: folder, autoSaveTranscripts: true, encryptTranscripts: true } as Settings
  const meeting: SaveMeeting = {
    title: 'Encrypted sync',
    mode: 'meeting',
    startedAt: 1_700_000_000_000,
    lines: [{ speaker: 'them', text: 'ENCRYPTED-LINE', t: 1_700_000_000_000 }],
    recap: ''
  }
  return saveMeeting(settings, meeting)
}

describe('meetingOpenTarget (History "Open")', () => {
  it('hands a plain meeting to the OS as-is', async () => {
    writeFileSync(join(folder, NAME), '# Weekly sync\n')
    expect(await meetingOpenTarget(folder, NAME)).toEqual({ ok: true, path: join(folder, NAME), encrypted: false })
  })

  it('hands an encrypted meeting over as a decrypted temp copy', async () => {
    const file = await saveEncryptedMeeting()
    const name = file.slice(folder.length + 1)
    const target = await meetingOpenTarget(folder, name)
    expect(target).toMatchObject({ ok: true, encrypted: true })
    if (!target.ok) throw new Error('unreachable')
    expect(target.path.startsWith(tempDir)).toBe(true)
    expect(readFileSync(target.path, 'utf8')).toContain('ENCRYPTED-LINE')
  })

  it('hands a missing meeting over unchanged, so the OS reports it', async () => {
    expect(await meetingOpenTarget(folder, NAME)).toEqual({ ok: true, path: join(folder, NAME), encrypted: false })
  })

  it('answers a cloud-only meeting with a notice and never reads it', async () => {
    useStorageForTests({ detector: everyFile('dataless') })
    writeFileSync(join(folder, NAME), '# Weekly sync\n')
    expect(await meetingOpenTarget(folder, NAME)).toEqual({ ok: false, error: MEETING_NOT_READABLE_MSG })
  })
})

describe('readSavedMeeting (History "Export copy")', () => {
  it('decodes an encrypted meeting', async () => {
    const file = await saveEncryptedMeeting()
    expect(await readSavedMeeting(folder, file.slice(folder.length + 1))).toContain('ENCRYPTED-LINE')
  })

  it('throws ENOENT for a missing meeting', async () => {
    await expect(readSavedMeeting(folder, NAME)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws without ENOENT for a cloud-only meeting', async () => {
    useStorageForTests({ detector: everyFile('dataless') })
    writeFileSync(join(folder, NAME), '# Weekly sync\n')
    const error = await readSavedMeeting(folder, NAME).catch((e: NodeJS.ErrnoException) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as NodeJS.ErrnoException).code).toBeUndefined()
  })
})

describe.skipIf(process.platform === 'win32')('a kernel-blocked meeting file never freezes History', () => {
  afterEach(async () => {
    for (let i = 0; i < 20 && releaseFifo(join(folder, NAME)); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  })

  it.each([
    ['Open', () => meetingOpenTarget(folder, NAME)],
    ['Export copy', () => readSavedMeeting(folder, NAME).catch((e: unknown) => e)]
  ])('%s settles within the read deadline with the event loop free', async (action, run) => {
    createFifo(join(folder, NAME))
    const loop = monitorEventLoopDelay({ resolution: 10 })
    loop.enable()
    const started = performance.now()
    try {
      const result = await run()
      expect(performance.now() - started).toBeLessThanOrEqual(5_500)
      expect(loop.max / 1e6).toBeLessThan(250)
      if (action === 'Open') expect(result).toEqual({ ok: false, error: MEETING_NOT_READABLE_MSG })
      else expect(result).toBeInstanceOf(Error)
    } finally {
      loop.disable()
    }
  }, 15_000)
})
