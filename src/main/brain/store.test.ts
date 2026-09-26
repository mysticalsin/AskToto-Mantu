import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync as realRmSync, writeFileSync, readFileSync as realReadFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import type { Settings } from '@shared/ipc'
import { BrainIndexSchema } from '@shared/brain'

vi.mock('electron')

/**
 * M2-0003 — unit coverage for the read/replace invariant primitives in store.ts that
 * mqa-175-brain-index-poison.test.ts (an integration-shaped suite) does not exercise directly: the pure
 * classifier, the I/O-vs-decode distinction, the io retry window, a failed set-aside rename, and the
 * once-per-classification log/audit contract. See docs/metis-2.0/designs/M2-0003-DESIGN.md §2.3/§5.2.
 *
 * `node:fs` is partially mocked so a fault can be injected on demand for exactly the primary
 * `.brain/index.json` path, following the pattern in store-durability.test.ts. Every other path (the
 * temp fixture directory itself, entity files, etc.) passes straight through to the real implementation.
 */
let failReadOnce: NodeJS.ErrnoException | null = null
let failReadPersistent: NodeJS.ErrnoException | null = null
let failRenameOnce: NodeJS.ErrnoException | null = null
const renameSyncSpy = vi.fn()

function mkErr(code: string, message = code): NodeJS.ErrnoException {
  const e = new Error(message) as NodeJS.ErrnoException
  e.code = code
  return e
}

function isPrimaryIndexPath(p: unknown): boolean {
  return typeof p === 'string' && p.replace(/\\/g, '/').endsWith('/.brain/index.json')
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (isPrimaryIndexPath(args[0])) {
        if (failReadOnce) {
          const err = failReadOnce
          failReadOnce = null
          throw err
        }
        if (failReadPersistent) throw failReadPersistent
      }
      return actual.readFileSync(...args)
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      renameSyncSpy(...args)
      if (isPrimaryIndexPath(args[0]) && failRenameOnce) {
        const err = failRenameOnce
        failRenameOnce = null
        throw err
      }
      return actual.renameSync(...args)
    }
  }
})

// Imported AFTER the mock factory (vi.mock is hoisted above this regardless of source order).
const store = await import('./store')
const logger = await import('../logger')

const ENC_MARKER_V2 = Buffer.from('ATKENC2\n', 'utf8')

/** Same FOREIGN-F shape as mqa-175-brain-index-poison.test.ts's fixture — a v2 envelope whose `kLocal`
 *  is not a key any process holds. A pure decode failure, needs no fs mocking. */
function foreignKeyIndexBytes(): Buffer {
  const env = {
    v: 2,
    iv: randomBytes(12).toString('base64'),
    tag: randomBytes(16).toString('base64'),
    ct: randomBytes(64).toString('base64'),
    kLocal: 'F:' + randomBytes(72).toString('base64')
  }
  return Buffer.concat([ENC_MARKER_V2, Buffer.from(JSON.stringify(env), 'utf8')])
}

describe('classifyIndexBytes — pure classification, no filesystem writes', () => {
  it('0 bytes -> absent; a healthy plaintext index -> ready; unparseable JSON -> corrupt', () => {
    expect(store.classifyIndexBytes(Buffer.alloc(0))).toEqual({ kind: 'absent' })

    const healthy = BrainIndexSchema.parse({})
    expect(store.classifyIndexBytes(Buffer.from(JSON.stringify(healthy), 'utf8'))).toEqual({ kind: 'ready', index: healthy })

    expect(store.classifyIndexBytes(Buffer.from('{"ingested": tru', 'utf8'))).toEqual({ kind: 'corrupt' })
  })

  it('a foreign-key envelope classifies as unavailable/undecryptable', () => {
    const load = store.classifyIndexBytes(foreignKeyIndexBytes())
    expect(load.kind).toBe('unavailable')
    expect((load as { cause?: string }).cause).toBe('undecryptable')
  })

  it('a newer schema_version classifies as unavailable/unsupported, never corrupt', () => {
    const bytes = Buffer.from(JSON.stringify({ schema_version: 99, ingested: 'new-shape' }), 'utf8')
    expect(store.classifyIndexBytes(bytes)).toEqual({ kind: 'unavailable', cause: 'unsupported' })
  })
})

describe('the read/replace invariant — I/O faults, retry, and quarantine limits', () => {
  let folder: string
  let s: Settings
  let primary: string

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-store-m2-0003-'))
    s = { meetingsFolder: folder } as Settings
    mkdirSync(join(folder, '.brain'), { recursive: true })
    primary = join(store.brainDir(s), 'index.json')
    failReadOnce = null
    failReadPersistent = null
    failRenameOnce = null
    renameSyncSpy.mockClear()
  })
  afterEach(() => {
    failReadOnce = null
    failReadPersistent = null
    failRenameOnce = null
    vi.useRealTimers()
    vi.restoreAllMocks()
    realRmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('an I/O error reading index.json (stat succeeds, read fails) is read-only, not "absent": writeIndex rejects \'io\', bytes unchanged', async () => {
    const healthy = BrainIndexSchema.parse({})
    healthy.ingested['a.md'] = { at: 1, ok: true }
    writeFileSync(primary, JSON.stringify(healthy), 'utf8')
    const before = realReadFileSync(primary)

    failReadPersistent = mkErr('ETIMEDOUT')

    expect(store.readIndex(s).ingested).toEqual({}) // never the swallowed-into-absent behaviour
    expect(store.indexUnavailable(s)).toBe('io')
    expect(realReadFileSync(primary)).toEqual(before)

    await expect(store.writeIndex(s, store.readIndex(s))).rejects.toBeInstanceOf(store.BrainIndexUnavailableError)
    await expect(store.writeIndex(s, store.readIndex(s))).rejects.toMatchObject({ unavailable: 'io' })
    expect(realReadFileSync(primary)).toEqual(before)
  })

  it('an I/O failure is retried after INDEX_IO_RETRY_MS, and the original ledger is then served', async () => {
    vi.useFakeTimers()
    const healthy = BrainIndexSchema.parse({})
    healthy.ingested['healed.md'] = { at: 1, ok: true }
    writeFileSync(primary, JSON.stringify(healthy), 'utf8')

    failReadPersistent = mkErr('ETIMEDOUT')
    expect(store.indexUnavailable(s)).toBe('io')
    expect(store.indexUnavailable(s)).toBe('io') // still within the retry window: no recovery yet

    vi.setSystemTime(Date.now() + store.INDEX_IO_RETRY_MS + 1)
    failReadPersistent = null // the transient condition (e.g. OneDrive hydrating) has cleared

    expect(store.readIndex(s).ingested['healed.md']?.ok).toBe(true)
    expect(store.indexUnavailable(s)).toBeNull()
  })

  it('a failed set-aside rename (EPERM) leaves the invalid index in place as \'corrupt-kept\', without spinning on every read', () => {
    const bad = Buffer.from('{"ingested": tru', 'utf8')
    writeFileSync(primary, bad)
    failRenameOnce = mkErr('EPERM')

    for (let i = 0; i < 3; i++) {
      expect(store.readIndex(s).ingested).toEqual({})
    }
    expect(store.indexUnavailable(s)).toBe('corrupt-kept')
    expect(existsSync(primary)).toBe(true)
    expect(realReadFileSync(primary)).toEqual(bad)
    // One rename ATTEMPT for the whole run (it failed and was cached) — not one per readIndex call.
    expect(renameSyncSpy).toHaveBeenCalledTimes(1)
  })

  it('unavailability is logged and audited once per classification, not once per poll', () => {
    const warnSpy = vi.spyOn(logger.mainLog, 'warn').mockImplementation(() => undefined as unknown as void)
    const auditSpy = vi.spyOn(logger, 'auditLog').mockImplementation(() => {})
    writeFileSync(primary, foreignKeyIndexBytes())

    for (let i = 0; i < 10; i++) store.readIndex(s)

    const auditCalls = auditSpy.mock.calls.filter((c) => c[0] === 'brain.index.unavailable')
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0][1]).toEqual({ cause: 'undecryptable' })
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('indexUnavailableMessage has content-free, non-empty copy for every IndexUnavailableCause', () => {
    for (const cause of ['io', 'undecryptable', 'unsupported', 'corrupt-kept'] as const) {
      const msg = store.indexUnavailableMessage(cause)
      expect(msg.length).toBeGreaterThan(20)
      expect(msg).not.toContain(folder) // never leaks a filesystem path
      expect(msg).not.toContain('.json')
    }
  })

  it('at the snapshot cap, a sixth invalid index is left read-only instead of set aside', () => {
    for (let i = 0; i < store.INDEX_AUTO_SNAPSHOT_CAP; i++) {
      writeFileSync(join(store.brainDir(s), `index.corrupt-auto-2026-09-2${i}T00-00-00-000Z-seed${i}.json`), `seed-${i}`)
    }
    const bad = Buffer.from('{"ingested": tru', 'utf8')
    writeFileSync(primary, bad)

    expect(store.readIndex(s).ingested).toEqual({})
    expect(store.indexUnavailable(s)).toBe('corrupt-kept')
    expect(
      readdirSync(store.brainDir(s)).filter((f) => f.startsWith('index.corrupt-auto-'))
    ).toHaveLength(store.INDEX_AUTO_SNAPSHOT_CAP) // no 6th snapshot created
  })
})
