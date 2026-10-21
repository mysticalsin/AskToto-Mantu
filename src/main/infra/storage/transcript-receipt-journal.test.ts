import { lstat, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createReceiptJournal,
  RECEIPT_JOURNAL_LIMIT,
  RECEIPT_JOURNAL_SCHEMA,
  type SaveReceiptRecord
} from './transcript-receipt-journal'

const io = vi.hoisted(() => ({
  randomHex: null as string | null,
  observe: false,
  tempPath: null as string | null,
  renameCount: 0,
  unlinkCount: 0,
  closeCount: 0,
  tempOpen: null as { flags: unknown; mode: unknown } | null,
  fault: null as string | null,
  primary: undefined as unknown,
  primaryArmed: false,
  closeError: undefined as unknown,
  closeErrorArmed: false,
  cleanupError: undefined as unknown,
  cleanupErrorArmed: false,
  renameError: undefined as unknown,
  renameErrorArmed: false,
  substitution: null as 'file' | 'symlink' | null,
  foreignTarget: null as string | null
}))

vi.mock('node:crypto', async () => {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto')
  return {
    ...actual,
    randomBytes: (size: number) => {
      if (size === 6 && io.randomHex !== null) {
        const hex = io.randomHex
        io.randomHex = null
        return Buffer.from(hex, 'hex')
      }
      return actual.randomBytes(size)
    }
  }
})

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const [path, flags, mode] = args
      const pathText = String(path)
      if (!io.observe || pathText !== io.tempPath) return handle
      io.tempOpen = { flags, mode }

      if (io.substitution === 'file') {
        await actual.unlink(pathText)
        await actual.writeFile(pathText, 'foreign replacement')
      } else if (io.substitution === 'symlink' && io.foreignTarget) {
        await actual.unlink(pathText)
        await actual.symlink(io.foreignTarget, pathText)
      }

      return new Proxy(handle, {
        get(target, property) {
          if (property === 'stat' && io.fault === 'stat') {
            return async () => {
              if (io.primaryArmed) throw io.primary
              throw new Error('descriptor identity unavailable')
            }
          }
          if (property === 'writeFile' && io.fault === 'partial-write') {
            return async (data: string | Uint8Array, options?: BufferEncoding) => {
              await target.writeFile(typeof data === 'string' ? data.slice(0, 8) : data.subarray(0, 8), options)
              if (io.primaryArmed) throw io.primary
              throw new Error('partial write rejected')
            }
          }
          if (property === 'sync' && io.fault === 'sync') {
            return async () => {
              await target.sync()
              if (io.primaryArmed) throw io.primary
              throw new Error('sync rejected')
            }
          }
          if (property === 'close') {
            return async () => {
              io.closeCount += 1
              const result = await target.close()
              if (io.closeErrorArmed) throw io.closeError
              return result
            }
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      }) as typeof handle
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (io.observe) io.renameCount += 1
      if (io.observe && io.renameErrorArmed) throw io.renameError
      return actual.rename(...args)
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (io.observe) io.unlinkCount += 1
      if (io.observe && io.cleanupErrorArmed && String(args[0]) === io.tempPath) throw io.cleanupError
      return actual.unlink(...args)
    }
  }
})

let dir: string
let file: string

beforeEach(async () => {
  Object.assign(io, {
    randomHex: null,
    observe: false,
    tempPath: null,
    renameCount: 0,
    unlinkCount: 0,
    closeCount: 0,
    tempOpen: null,
    fault: null,
    primary: undefined,
    primaryArmed: false,
    closeError: undefined,
    closeErrorArmed: false,
    cleanupError: undefined,
    cleanupErrorArmed: false,
    renameError: undefined,
    renameErrorArmed: false,
    substitution: null,
    foreignTarget: null
  })
  dir = await mkdtemp(join(tmpdir(), 'metis-receipts-'))
  file = join(dir, 'transcript-receipts', 'receipts.v1.json')
})
afterEach(async () => {
  io.observe = false
  await rm(dir, { recursive: true, force: true })
})

const record = (receiptId: string, patch: Partial<SaveReceiptRecord> = {}): SaveReceiptRecord => ({
  receiptId,
  ownerKey: '7:1700000000000',
  authGeneration: 7,
  meetingStartedAt: 1_700_000_000_000,
  payloadSha256: 'a'.repeat(64),
  revision: 3,
  stages: {
    draftSealed: false,
    savedWritten: true,
    brainIngestQueued: false,
    draftsUnlinked: false,
    receiptsDeleted: false
  },
  completed: ['summary-credit'],
  savedBasename: '2023-11-14_221320-planning.md',
  folderIdSha256: 'b'.repeat(64),
  updatedAt: 1,
  ...patch
})

const controlTemp = (hex = 'a1b2c3d4e5f6') => {
  if (hex.length !== 12) throw new Error('Controlled random basename must contain exactly six bytes')
  io.randomHex = hex
  io.tempPath = `${file}.${hex}.tmp`
}

describe('transcript receipt journal', () => {
  it('preserves a colliding temporary file it did not create through the exported put API', async () => {
    const journal = createReceiptJournal(file)
    await journal.put(record('existing'))
    const originalJournal = await readFile(file)
    const sentinel = Buffer.from('foreign temporary file')
    controlTemp()
    await writeFile(io.tempPath!, sentinel, { mode: 0o600 })
    io.observe = true

    let rejection: unknown
    try {
      await journal.put(record('next'))
    } catch (error) {
      rejection = error
    }

    const journalAfter = await readFile(file)
    const sentinelAfter = await readFile(io.tempPath!).catch(() => null)
    expect({
      rejectionCode: (rejection as NodeJS.ErrnoException | undefined)?.code,
      journalUnchanged: journalAfter.equals(originalJournal),
      sentinelUnchanged: sentinelAfter?.equals(sentinel) ?? false,
      renameCount: io.renameCount
    }).toEqual({ rejectionCode: 'EEXIST', journalUnchanged: true, sentinelUnchanged: true, renameCount: 0 })
  })

  it('closes after a partial write failure, keeps the first error and leaves the queue usable', async () => {
    const journal = createReceiptJournal(file)
    await journal.put(record('existing'))
    const originalJournal = await readFile(file)
    const primary = new Error('write failed after partial bytes')
    controlTemp('a1b2c3d4e501')
    io.observe = true
    io.fault = 'partial-write'
    io.primary = primary
    io.primaryArmed = true

    let rejection: unknown
    try {
      await journal.put(record('failed'))
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBe(primary)
    expect(await readFile(file)).toEqual(originalJournal)
    expect(io.renameCount).toBe(0)
    expect(io.closeCount).toBe(1)
    await expect(readFile(io.tempPath!)).rejects.toMatchObject({ code: 'ENOENT' })

    controlTemp('a1b2c3d4e502')
    io.fault = null
    io.primaryArmed = false
    await journal.put(record('after'))
    const loaded = await journal.load()
    expect(loaded.ok && loaded.records.map(({ receiptId }) => receiptId)).toEqual(['existing', 'after'])
    expect(io.tempOpen).toEqual({ flags: 'wx', mode: 0o600 })
    expect(io.renameCount).toBe(1)
  })

  it('prevents promotion after a sync rejection and cleans only the owned temporary', async () => {
    const journal = createReceiptJournal(file)
    await journal.put(record('existing'))
    const originalJournal = await readFile(file)
    const primary = new Error('sync rejected')
    controlTemp('a1b2c3d4e503')
    io.observe = true
    io.fault = 'sync'
    io.primary = primary
    io.primaryArmed = true

    let rejection: unknown
    try {
      await journal.put(record('next'))
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBe(primary)
    expect(await readFile(file)).toEqual(originalJournal)
    expect(io.renameCount).toBe(0)
    expect(io.closeCount).toBe(1)
    await expect(readFile(io.tempPath!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not retry a close that releases its descriptor and then rejects', async () => {
    const journal = createReceiptJournal(file)
    await journal.put(record('existing'))
    const originalJournal = await readFile(file)
    const primary = new Error('close rejected after release')
    controlTemp('a1b2c3d4e504')
    io.observe = true
    io.closeError = primary
    io.closeErrorArmed = true

    let rejection: unknown
    try {
      await journal.put(record('next'))
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBe(primary)
    expect(await readFile(file)).toEqual(originalJournal)
    expect(io.closeCount).toBe(1)
    expect(io.renameCount).toBe(0)
    await expect(readFile(io.tempPath!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a write error when close and cleanup also reject', async () => {
    const journal = createReceiptJournal(file)
    await journal.put(record('existing'))
    const originalJournal = await readFile(file)
    const primary = new Error('primary write failure')
    controlTemp('a1b2c3d4e505')
    io.observe = true
    io.fault = 'partial-write'
    io.primary = primary
    io.primaryArmed = true
    io.closeError = new Error('secondary close failure')
    io.closeErrorArmed = true
    io.cleanupError = new Error('secondary cleanup failure')
    io.cleanupErrorArmed = true

    let rejection: unknown
    try {
      await journal.put(record('next'))
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBe(primary)
    expect(await readFile(file)).toEqual(originalJournal)
    expect(io.closeCount).toBe(1)
    expect(io.unlinkCount).toBe(1)
    expect(io.renameCount).toBe(0)
    await expect(readFile(io.tempPath!)).resolves.toHaveLength(8)
  })

  it('refuses an unavailable descriptor identity and closes the acquired handle once', async () => {
    const journal = createReceiptJournal(file)
    await journal.put(record('existing'))
    const originalJournal = await readFile(file)
    const primary = new Error('descriptor identity unavailable')
    controlTemp('a1b2c3d4e506')
    io.observe = true
    io.fault = 'stat'
    io.primary = primary
    io.primaryArmed = true

    let rejection: unknown
    try {
      await journal.put(record('next'))
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBe(primary)
    expect(await readFile(file)).toEqual(originalJournal)
    expect(io.closeCount).toBe(1)
    expect(io.renameCount).toBe(0)
    await expect(readFile(io.tempPath!)).resolves.toHaveLength(0)
  })

  it.each([
    { label: 'undefined', value: undefined, index: 0 },
    { label: 'null', value: null, index: 1 },
    { label: 'false', value: false, index: 2 },
    { label: 'zero', value: 0, index: 3 },
    { label: 'empty string', value: '', index: 4 }
  ])('preserves an exact falsy write failure: $label', async ({ value, index }) => {
    const journal = createReceiptJournal(file)
    await journal.put(record('existing'))
    const originalJournal = await readFile(file)
    controlTemp(`a1b2c3d4e5f${index}`)
    io.observe = true
    io.fault = 'partial-write'
    io.primary = value
    io.primaryArmed = true

    let rejected = false
    let rejection: unknown
    try {
      await journal.put(record(`falsy-${index}`))
    } catch (error) {
      rejected = true
      rejection = error
    }

    expect(rejected).toBe(true)
    expect(rejection).toBe(value)
    expect(await readFile(file)).toEqual(originalJournal)
    expect(io.closeCount).toBe(1)
    expect(io.renameCount).toBe(0)
    await expect(readFile(io.tempPath!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not promote or remove a regular file substituted after exclusive open', async () => {
    const journal = createReceiptJournal(file)
    await journal.put(record('existing'))
    const originalJournal = await readFile(file)
    controlTemp('a1b2c3d4e520')
    io.observe = true
    io.substitution = 'file'

    let rejection: unknown
    try {
      await journal.put(record('next'))
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBeInstanceOf(Error)
    expect(await readFile(file)).toEqual(originalJournal)
    expect(await readFile(io.tempPath!, 'utf8')).toBe('foreign replacement')
    expect(io.closeCount).toBe(1)
    expect(io.renameCount).toBe(0)
  })

  it('does not promote or remove a symlink substituted after exclusive open', async () => {
    const journal = createReceiptJournal(file)
    await journal.put(record('existing'))
    const originalJournal = await readFile(file)
    const target = join(dir, 'foreign-target')
    await writeFile(target, 'foreign symlink target')
    controlTemp('a1b2c3d4e521')
    io.observe = true
    io.substitution = 'symlink'
    io.foreignTarget = target

    let rejection: unknown
    try {
      await journal.put(record('next'))
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBeInstanceOf(Error)
    expect(await readFile(file)).toEqual(originalJournal)
    expect((await lstat(io.tempPath!)).isSymbolicLink()).toBe(true)
    expect(await readlink(io.tempPath!)).toBe(target)
    expect(await readFile(target, 'utf8')).toBe('foreign symlink target')
    expect(io.closeCount).toBe(1)
    expect(io.renameCount).toBe(0)
  })

  it('cleans an owned temporary after rename rejects before promotion', async () => {
    const journal = createReceiptJournal(file)
    await journal.put(record('existing'))
    const originalJournal = await readFile(file)
    const primary = new Error('rename rejected')
    controlTemp('a1b2c3d4e522')
    io.observe = true
    io.renameError = primary
    io.renameErrorArmed = true

    let rejection: unknown
    try {
      await journal.put(record('next'))
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBe(primary)
    expect(await readFile(file)).toEqual(originalJournal)
    expect(io.renameCount).toBe(1)
    expect(io.closeCount).toBe(1)
    await expect(readFile(io.tempPath!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('round-trips records through atomic temp and rename', async () => {
    const journal = createReceiptJournal(file)
    await expect(journal.load()).resolves.toEqual({ ok: true, records: [] })
    await journal.put(record('r1'))
    await journal.put(record('r2'))
    await journal.put(record('r1', { completed: ['summary-credit', 'draft-cleanup'] }))
    const reopened = createReceiptJournal(file)
    const loaded = await reopened.load()
    expect(loaded).toEqual({
      ok: true,
      records: [record('r2'), record('r1', { completed: ['summary-credit', 'draft-cleanup'] })]
    })
    expect(JSON.parse(await readFile(file, 'utf8')).schema).toBe(RECEIPT_JOURNAL_SCHEMA)
    // No temp file survives a completed write.
    expect(await readdir(join(dir, 'transcript-receipts'))).toEqual(['receipts.v1.json'])
    await reopened.remove('r2')
    await reopened.remove('missing')
    expect(await createReceiptJournal(file).load()).toEqual({
      ok: true,
      records: [record('r1', { completed: ['summary-credit', 'draft-cleanup'] })]
    })
  })

  it('serializes concurrent writes so none is lost', async () => {
    const journal = createReceiptJournal(file)
    await Promise.all(Array.from({ length: 20 }, (_, i) => journal.put(record(`r${i}`))))
    const loaded = await createReceiptJournal(file).load()
    expect(loaded.ok && loaded.records.map((r) => r.receiptId).sort()).toEqual(
      Array.from({ length: 20 }, (_, i) => `r${i}`).sort()
    )
  })

  it('treats unknown major schema as corrupt and keeps drafts', async () => {
    await createReceiptJournal(file).put(record('r1'))
    const future = JSON.stringify({ schema: 'metis.save-receipts.v2', records: [] })
    await writeFile(file, future)
    const journal = createReceiptJournal(file)
    await expect(journal.load()).resolves.toEqual({ ok: false, error: 'corrupt' })
    // Fail closed: a corrupt journal is never overwritten, so nothing it holds is lost or replaced.
    await expect(journal.put(record('r2'))).rejects.toThrow(/corrupt/)
    await expect(journal.remove('r1')).rejects.toThrow(/corrupt/)
    expect(await readFile(file, 'utf8')).toBe(future)
    await writeFile(file, '{not json')
    await expect(journal.load()).resolves.toEqual({ ok: false, error: 'corrupt' })
  })

  it('reports an unreadable journal distinctly from a missing one', async () => {
    await createReceiptJournal(file).put(record('r1'))
    await rm(file)
    await writeFile(file, '') // empty is corrupt, not missing
    await expect(createReceiptJournal(file).load()).resolves.toEqual({ ok: false, error: 'corrupt' })
    await rm(file)
    await expect(createReceiptJournal(file).load()).resolves.toEqual({ ok: true, records: [] })
    await expect(createReceiptJournal(dir).load()).resolves.toEqual({ ok: false, error: 'unreadable' })
  })

  it('contains no transcript text or full paths', async () => {
    const journal = createReceiptJournal(file)
    await expect(journal.put(record('r1', { savedBasename: join(dir, 'meeting.md') }))).rejects.toThrow()
    await expect(journal.put(record('r1', { savedBasename: '..' }))).rejects.toThrow()
    const withText = { ...record('r1'), text: 'Shall we ship on Friday?' } as SaveReceiptRecord
    await expect(journal.put(withText)).rejects.toThrow()
    await journal.put(record('r1'))
    const bytes = await readFile(file, 'utf8')
    expect(bytes).not.toContain(dir)
    expect(bytes).not.toMatch(/[/\\]/)
  })

  it(`refuses a record beyond ${RECEIPT_JOURNAL_LIMIT} instead of evicting one`, async () => {
    const full = Array.from({ length: RECEIPT_JOURNAL_LIMIT }, (_, i) => record(`r${i}`))
    await createReceiptJournal(file).put(full[0])
    await writeFile(file, JSON.stringify({ schema: RECEIPT_JOURNAL_SCHEMA, records: full }))
    const journal = createReceiptJournal(file)
    await expect(journal.put(record('extra'))).rejects.toThrow(/full/)
    await journal.put(record('r5', { completed: ['summary-credit', 'audit'] }))
    const loaded = await journal.load()
    expect(loaded.ok && loaded.records).toHaveLength(RECEIPT_JOURNAL_LIMIT)
  })
})
