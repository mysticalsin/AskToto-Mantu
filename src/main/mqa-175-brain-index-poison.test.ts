import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes, createCipheriv } from 'node:crypto'
import { safeStorage } from 'electron'
import type { Settings } from '@shared/ipc'
import { brainDir, readIndex, writeIndex } from './brain/store'
import { beginBootWatch, endBootWatch, describeEarlyDeath } from './boot-sentinel'

vi.mock('electron')

const ENC_MARKER_V2 = Buffer.from('ATKENC2\n', 'utf8')

/**
 * MQA-175 — an undecryptable `<meetingsFolder>/.brain/index.json` bricked the shipped app: it took the
 * process down 15-20s after launch (the `resumeBackfillIfPending()` boot timer), with no window, no
 * dialog, no crash-*.log and no audit line, on every single launch.
 *
 * The fixtures below are byte-equivalent to the real poisoned file recovered from the field profile:
 * an `ATKENC2\n` v2 envelope with an `S:`-wrapped (safeStorage/DPAPI) content key whose AES-GCM payload
 * fails authentication.
 */

/** A valid v2 envelope for `content`, wrapped the way the mock keychain wraps (`enc:` + plaintext). */
function envelopeV2(content: string): { buf: Buffer; contentKey: Buffer } {
  const contentKey = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', contentKey, iv)
  const ct = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()])
  const env = {
    v: 2,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
    kLocal: 'S:' + Buffer.from(`enc:${contentKey.toString('base64')}`, 'utf8').toString('base64')
  }
  return { buf: Buffer.concat([ENC_MARKER_V2, Buffer.from(JSON.stringify(env), 'utf8')]), contentKey }
}

/** The real-world shape: a v2 envelope whose ciphertext has one byte flipped, so GCM auth fails while
 *  the wrapped content key itself still unwraps perfectly (exactly the field file's behaviour). */
function poisonedIndexBytes(): Buffer {
  const { buf } = envelopeV2(JSON.stringify({ schema_version: 5, ingested: { 'meeting-a.md': { at: 1, ok: true } } }))
  const env = JSON.parse(buf.subarray(ENC_MARKER_V2.length).toString('utf8')) as { ct: string }
  const ct = Buffer.from(env.ct, 'base64')
  ct[0] ^= 0xff // flip a byte -> auth tag no longer matches
  return Buffer.concat([
    ENC_MARKER_V2,
    Buffer.from(JSON.stringify({ ...env, ct: ct.toString('base64') }), 'utf8')
  ])
}

describe('MQA-175 — a poisoned .brain/index.json must degrade, not kill the app', () => {
  let folder: string
  let s: Settings

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'asktoto-mqa175-'))
    s = { meetingsFolder: folder } as Settings
    mkdirSync(join(folder, '.brain'), { recursive: true })
    vi.mocked(safeStorage.decryptString).mockClear()
  })
  afterEach(() => {
    rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('MQA-175: never hands the native keychain a truncated OSCrypt blob (the C++ throw no JS catch can hold)', () => {
    // Chromium's os_crypt_win.cc reaches past the 'v10' prefix with std::string::substr(15) and NO
    // length check: a shorter blob raises std::out_of_range, a native C++ exception (0xE06D7363) that
    // unwinds straight past V8 — no try/catch, no handler, no diagnostics, process gone.
    const truncated = Buffer.concat([Buffer.from('v10', 'utf8'), randomBytes(4)]) // 7 bytes, substr(15) throws
    const env = {
      v: 2,
      iv: randomBytes(12).toString('base64'),
      tag: randomBytes(16).toString('base64'),
      ct: randomBytes(32).toString('base64'),
      kLocal: 'S:' + truncated.toString('base64')
    }
    writeFileSync(
      join(brainDir(s), 'index.json'),
      Buffer.concat([ENC_MARKER_V2, Buffer.from(JSON.stringify(env), 'utf8')])
    )

    expect(() => readIndex(s)).not.toThrow()

    const handedOver = vi.mocked(safeStorage.decryptString).mock.calls.map((c) => c[0] as Buffer)
    const impossible = handedOver.filter((b) => b.subarray(0, 3).toString('utf8') === 'v10' && b.length < 15)
    expect(impossible).toHaveLength(0)
  })

  it('MQA-175: preserves an undecryptable index.json aside and continues with a rebuildable empty index', async () => {
    const poisoned = poisonedIndexBytes()
    const primary = join(brainDir(s), 'index.json')
    writeFileSync(primary, poisoned)

    const idx = readIndex(s)
    expect(idx.ingested).toEqual({}) // rebuildable empty index — the app keeps running

    // The bad file is preserved, not deleted and not left in place to poison every future read.
    const preserved = readdirSync(brainDir(s)).filter((f) => /^index\.corrupt-.*\.json$/.test(f))
    expect(preserved).toHaveLength(1)
    expect(readFileSync(join(brainDir(s), preserved[0]))).toEqual(poisoned)
    expect(existsSync(primary)).toBe(false)

    // ...and the store is writable again: the next ingest rebuilds the index from the transcripts.
    const next = readIndex(s)
    next.ingested['meeting-b.md'] = { at: 2, ok: true }
    await writeIndex(s, next)
    expect(readIndex(s).ingested['meeting-b.md']?.ok).toBe(true)
  })

  it('MQA-175: leaves a healthy index.json alone (no quarantine, no data loss)', async () => {
    const idx = readIndex(s)
    idx.ingested['healthy.md'] = { at: 3, ok: true }
    await writeIndex(s, idx)
    expect(readIndex(s).ingested['healthy.md']?.ok).toBe(true)
    expect(readdirSync(brainDir(s)).filter((f) => f.includes('.corrupt-'))).toHaveLength(0)
  })
})


describe('MQA-175 — an early death must leave a trace and route the next launch to safety', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'asktoto-mqa175-ud-'))
  })
  afterEach(() => {
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('MQA-175: a run that never closes its boot watch is reported as an early death on the next launch', () => {
    expect(beginBootWatch(userData, '1.5.4')).toBeNull() // first ever launch: nothing to report

    // ...that run dies before endBootWatch — exactly what a native C++ exception does: no handler runs.
    // Crashpad, however, did capture a dump, and the app has never once looked at one.
    const reports = join(userData, 'Crashpad', 'reports')
    mkdirSync(reports, { recursive: true })
    writeFileSync(join(reports, 'aaaa-bbbb.dmp'), 'minidump')

    const death = beginBootWatch(userData, '1.5.4')
    expect(death).not.toBeNull()
    expect(death?.consecutive).toBe(1)
    expect(death?.version).toBe('1.5.4')
    expect(death?.crashDump).toBe('aaaa-bbbb.dmp')
    expect(describeEarlyDeath(death!)).toContain('aaaa-bbbb.dmp')

    // A second death in a row is distinguishable from a one-off.
    expect(beginBootWatch(userData, '1.5.4')?.consecutive).toBe(2)
  })

  it('MQA-175: a launch that completes its boot watch is never reported as a death', () => {
    expect(beginBootWatch(userData, '1.5.4')).toBeNull()
    endBootWatch(userData)
    expect(beginBootWatch(userData, '1.5.4')).toBeNull()
    endBootWatch(userData)
    expect(existsSync(join(userData, 'boot-incomplete.json'))).toBe(false)
  })

  it('MQA-175: the boot sequence routes the brain resume through the early-death check and clears the watch after it', () => {
    // Source contract (same pattern as crash-capture.test.ts): the 15s timer that calls
    // resumeBackfillIfPending IS the step the poisoned .brain kills, so it must be skipped after an
    // early death — and the watch must only close once that step has actually survived.
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    expect(source).toMatch(/const earlyDeath = beginBootWatch\(/)
    const resume = source.indexOf('resumeBackfillIfPending()')
    const guard = source.lastIndexOf('if (earlyDeath)', resume)
    const clear = source.indexOf('endBootWatch(', resume)
    expect(guard).toBeGreaterThan(-1)
    expect(resume).toBeGreaterThan(guard) // the resume sits inside the early-death branch
    expect(clear).toBeGreaterThan(resume) // ...and the watch closes only after it survived
  })
})
