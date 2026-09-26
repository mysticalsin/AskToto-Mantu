import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes, createCipheriv, createHash } from 'node:crypto'
import { safeStorage } from 'electron'
import type { Settings } from '@shared/ipc'
import { BrainIndexSchema } from '@shared/brain'
import { brainDir, readIndex, writeIndex, indexUnavailable, purgeBrain, BrainIndexUnavailableError } from './brain/store'
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
 *
 * M2-0003 replaces the rename-on-any-decode-failure behaviour above with a read/replace invariant
 * (docs/metis-2.0/designs/M2-0003-DESIGN.md): index.json is renamed or overwritten only when THIS
 * process fully decoded its current bytes. Anything it could not decode — another device's key, an
 * unavailable keystore, damaged own ciphertext (indistinguishable from the two above under AES-GCM) — is
 * left byte-identical and the index is read-only for the session. Only decoded-but-invalid bytes are
 * still set aside, capped at 5 automatic snapshots per `.brain`, and the pre-existing legacy
 * `index.corrupt-<ISO>.json` files are never touched by any automatic path.
 */

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

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
 *  the wrapped content key itself still unwraps perfectly (exactly the field file's behaviour). This is
 *  DAMAGED-OWN: bytes this device wrapped, but the content itself is now corrupt. AES-GCM auth failure
 *  cannot tell this apart from a foreign key (see M2-0003-DESIGN.md §1), so M2-0003 treats it the same
 *  way as FOREIGN-F: read-only, never auto-quarantined (see M4 below — this replaces the pre-M2-0003
 *  behaviour of auto-quarantining it).
 */
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

/** FOREIGN-F — the incident fixture (RUNTIME-EVIDENCE "Brain index quarantine"): a v2 envelope whose
 *  `kLocal` is the file-backend ('F:') wrap of 72 random bytes — never a key any process holds. Reproduces
 *  the exact `decodeSavedResult` failure logged in the field: "Unsupported state or unable to
 *  authenticate data" (decryptSecret's AES-GCM auth tag never matches). */
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
    vi.unstubAllEnvs()
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
    const bytes = Buffer.concat([ENC_MARKER_V2, Buffer.from(JSON.stringify(env), 'utf8')])
    const primary = join(brainDir(s), 'index.json')
    writeFileSync(primary, bytes)
    const before = sha256(bytes)

    expect(() => readIndex(s)).not.toThrow()

    // M2-0003: an unusable-here index is never rewritten — this is a decode failure like any other.
    expect(sha256(readFileSync(primary))).toBe(before)

    const handedOver = vi.mocked(safeStorage.decryptString).mock.calls.map((c) => c[0] as Buffer)
    const impossible = handedOver.filter((b) => b.subarray(0, 3).toString('utf8') === 'v10' && b.length < 15)
    expect(impossible).toHaveLength(0)
  })

  it('M2-0003: a foreign-key index.json is byte-identical after readIndex, and readIndex returns an empty stand-in', () => {
    const bytes = foreignKeyIndexBytes()
    const primary = join(brainDir(s), 'index.json')
    writeFileSync(primary, bytes)
    const before = sha256(bytes)

    const idx = readIndex(s)
    expect(idx.ingested).toEqual({})

    expect(sha256(readFileSync(primary))).toBe(before)
    expect(readdirSync(brainDir(s)).filter((f) => f.includes('.corrupt-'))).toHaveLength(0)
    expect(indexUnavailable(s)).toBe('undecryptable')
  })

  it("M2-0003: writeIndex refuses to replace a foreign-key index.json (BrainIndexUnavailableError 'undecryptable'), bytes unchanged", async () => {
    const bytes = foreignKeyIndexBytes()
    const primary = join(brainDir(s), 'index.json')
    writeFileSync(primary, bytes)
    const before = sha256(bytes)

    const idx = readIndex(s)
    idx.ingested['new.md'] = { at: 1, ok: true }

    await expect(writeIndex(s, idx)).rejects.toBeInstanceOf(BrainIndexUnavailableError)
    await expect(writeIndex(s, idx)).rejects.toMatchObject({ unavailable: 'undecryptable' })
    expect(sha256(readFileSync(primary))).toBe(before)
  })

  it('M2-0003: keystore-unavailable leaves index.json byte-identical, and a fresh process with the keystore back reads the original ledger', async () => {
    const primary = join(brainDir(s), 'index.json')
    const { buf } = envelopeV2(JSON.stringify({ schema_version: 2, ingested: { 'a.md': { at: 1, ok: true } } }))
    writeFileSync(primary, buf)
    const before = sha256(buf)

    // ASKTOTO_LOCAL_KEYSTORE forces the 'S:'-wrapped path closed (transcripts.ts's decryptEnvelopeV2) —
    // the same real-world case as a device whose OS keychain is unavailable this session.
    vi.stubEnv('ASKTOTO_LOCAL_KEYSTORE', '1')
    const idx = readIndex(s)
    expect(idx.ingested).toEqual({})
    expect(indexUnavailable(s)).toBe('undecryptable')
    expect(sha256(readFileSync(primary))).toBe(before)

    // Simulate the keystore coming back on the next launch: a brand-new process, not merely clearing
    // the env var on the SAME module instance (whose stat-keyed cache would otherwise mask this).
    vi.unstubAllEnvs()
    vi.resetModules()
    const fresh = await import('./brain/store')
    expect(fresh.readIndex(s).ingested['a.md']?.ok).toBe(true)
    expect(fresh.indexUnavailable(s)).toBeNull()
  })

  it('M2-0003: damaged own ciphertext is no longer auto-quarantined — left in place, read-only', () => {
    // MQA-175's original fixture and behaviour change (design A4): a decode failure this device caused
    // itself (a torn write) is indistinguishable from FOREIGN-F under AES-GCM, so it gets the same
    // read-only treatment, not a rename. Replaces the pre-M2-0003 "preserves an undecryptable index.json
    // aside..." test, which asserted the opposite.
    const poisoned = poisonedIndexBytes()
    const primary = join(brainDir(s), 'index.json')
    writeFileSync(primary, poisoned)
    const before = sha256(poisoned)

    const idx = readIndex(s)
    expect(idx.ingested).toEqual({})

    expect(existsSync(primary)).toBe(true)
    expect(sha256(readFileSync(primary))).toBe(before)
    expect(readdirSync(brainDir(s)).filter((f) => f.includes('.corrupt-'))).toHaveLength(0)
    expect(indexUnavailable(s)).toBe('undecryptable')
  })

  it('M2-0003: decoded-but-invalid plaintext is set aside as index.corrupt-auto-*.json with identical bytes, and the store is writable again', async () => {
    const bad = Buffer.from('{"ingested": tru', 'utf8')
    const primary = join(brainDir(s), 'index.json')
    writeFileSync(primary, bad)

    const idx = readIndex(s)
    expect(idx.ingested).toEqual({})
    expect(existsSync(primary)).toBe(false) // moved aside, not left in place — decoded fine, just invalid

    const preserved = readdirSync(brainDir(s)).filter((f) => /^index\.corrupt-auto-.*\.json$/.test(f))
    expect(preserved).toHaveLength(1)
    expect(readFileSync(join(brainDir(s), preserved[0]))).toEqual(bad)

    // ...and the store is writable again: the next ingest rebuilds the index from the transcripts.
    idx.ingested['meeting-b.md'] = { at: 2, ok: true }
    await writeIndex(s, idx)
    expect(readIndex(s).ingested['meeting-b.md']?.ok).toBe(true)
  })

  it('M2-0003: decoded-but-invalid content inside an authenticated envelope is set aside the same way', () => {
    const { buf } = envelopeV2('not json')
    const primary = join(brainDir(s), 'index.json')
    writeFileSync(primary, buf)

    const idx = readIndex(s)
    expect(idx.ingested).toEqual({})
    expect(existsSync(primary)).toBe(false)

    const preserved = readdirSync(brainDir(s)).filter((f) => /^index\.corrupt-auto-.*\.json$/.test(f))
    expect(preserved).toHaveLength(1)
    expect(readFileSync(join(brainDir(s), preserved[0]))).toEqual(buf)
  })

  it('M2-0003: legacy index.corrupt-<ISO>.json snapshots are never counted, renamed or deleted', () => {
    const legacyNames = [
      'index.corrupt-2026-08-20T00-00-00-000Z.json',
      'index.corrupt-2026-09-05T00-00-00-000Z.json',
      'index.corrupt-2026-09-06T00-00-00-000Z.json'
    ]
    const legacyContents = legacyNames.map((name, i) => {
      const content = Buffer.from(`legacy-quarantine-content-${i}`, 'utf8')
      writeFileSync(join(brainDir(s), name), content)
      return content
    })

    const bad = Buffer.from('{"ingested": tru', 'utf8')
    writeFileSync(join(brainDir(s), 'index.json'), bad)
    readIndex(s)

    // The new auto- scheme still quarantines decoded-but-invalid bytes...
    const preserved = readdirSync(brainDir(s)).filter((f) => /^index\.corrupt-auto-.*\.json$/.test(f))
    expect(preserved).toHaveLength(1)

    // ...but never touches the pre-existing legacy ISO-named files: same names, same bytes.
    legacyNames.forEach((name, i) => {
      expect(existsSync(join(brainDir(s), name))).toBe(true)
      expect(readFileSync(join(brainDir(s), name))).toEqual(legacyContents[i])
    })
  })

  it("M2-0003: at 5 auto snapshots a sixth invalid index is left in place and read-only ('corrupt-kept')", async () => {
    for (let i = 0; i < 5; i++) {
      writeFileSync(
        join(brainDir(s), `index.corrupt-auto-2026-09-2${i}T00-00-00-000Z-seed${i}.json`),
        `seed-snapshot-${i}`
      )
    }
    const before5 = readdirSync(brainDir(s)).filter((f) => f.startsWith('index.corrupt-auto-')).sort()
    expect(before5).toHaveLength(5)

    const bad = Buffer.from('{"ingested": tru', 'utf8')
    const primary = join(brainDir(s), 'index.json')
    writeFileSync(primary, bad)

    const idx = readIndex(s)
    expect(idx.ingested).toEqual({})
    expect(indexUnavailable(s)).toBe('corrupt-kept')

    // The 6th invalid index stays exactly where it was — no rename past the cap.
    expect(existsSync(primary)).toBe(true)
    expect(readFileSync(primary)).toEqual(bad)
    const after5 = readdirSync(brainDir(s)).filter((f) => f.startsWith('index.corrupt-auto-')).sort()
    expect(after5).toEqual(before5) // no 6th snapshot created

    await expect(writeIndex(s, idx)).rejects.toMatchObject({ unavailable: 'corrupt-kept' })
  })

  it("M2-0003: an index from a newer schema_version is never quarantined ('unsupported')", () => {
    const bytes = Buffer.from(JSON.stringify({ schema_version: 99, ingested: 'new-shape' }), 'utf8')
    const primary = join(brainDir(s), 'index.json')
    writeFileSync(primary, bytes)

    const idx = readIndex(s)
    expect(idx.ingested).toEqual({})
    expect(indexUnavailable(s)).toBe('unsupported')
    expect(readFileSync(primary)).toEqual(bytes)
    expect(readdirSync(brainDir(s)).filter((f) => f.includes('.corrupt-'))).toHaveLength(0)
  })

  it('M2-0003: purge ends the read-only state — no in-memory ledger outlives the file', async () => {
    // Regression guard for the prior (pre-design) F1: a session-only shadow index that outlived a purge.
    writeFileSync(join(brainDir(s), 'index.json'), foreignKeyIndexBytes())
    readIndex(s)
    expect(indexUnavailable(s)).toBe('undecryptable')

    const r = purgeBrain(s)
    expect(r.ok).toBe(true)
    expect(indexUnavailable(s)).toBeNull()

    const idx = readIndex(s)
    idx.ingested['fresh.md'] = { at: 1, ok: true }
    await writeIndex(s, idx)
    expect(readIndex(s).ingested['fresh.md']?.ok).toBe(true)
  })

  it('M2-0003: the read-only state ends when the bytes become readable, with no restart', async () => {
    const primary = join(brainDir(s), 'index.json')
    writeFileSync(primary, foreignKeyIndexBytes())
    readIndex(s)
    expect(indexUnavailable(s)).toBe('undecryptable')

    const healthy = BrainIndexSchema.parse({})
    healthy.ingested['healed.md'] = { at: 1, ok: true }
    writeFileSync(primary, JSON.stringify(healthy))

    expect(readIndex(s).ingested['healed.md']?.ok).toBe(true)
    expect(indexUnavailable(s)).toBeNull()

    const idx = readIndex(s)
    idx.ingested['more.md'] = { at: 2, ok: true }
    await writeIndex(s, idx)
    expect(readIndex(s).ingested['more.md']?.ok).toBe(true)
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
    // early death. FITO-185-G-TIMER: sentinel may also clear earlier (past createWindow/registerIpc
    // kill zone); the 15s finally still backstops via clearBootWatchOnce('mqa-175').
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    expect(source).toMatch(/const earlyDeath = beginBootWatch\(/)
    const resume = source.indexOf('resumeBackfillIfPending()')
    const guard = source.lastIndexOf('if (earlyDeath)', resume)
    expect(guard).toBeGreaterThan(-1)
    expect(resume).toBeGreaterThan(guard) // the resume sits inside the early-death branch
    const timer = source.lastIndexOf('setTimeout(() => {', resume)
    const slice = source.slice(timer, source.indexOf('}, 15_000)', resume) + '}, 15_000)'.length)
    expect(slice).toMatch(/clearBootWatchOnce\('mqa-175'\)/)
  })

  it('FITO-185-B: boot holds prevent-app-suspension from beginBootWatch until 15s brain clear', () => {
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    const begin = source.indexOf('const earlyDeath = beginBootWatch(')
    expect(begin).toBeGreaterThan(-1)
    const start = source.indexOf('setBootPowerSaveBlock(true)', begin)
    expect(start).toBeGreaterThan(begin)
    // Power-save must arm before createWindow so exclusive hidden first-paint is not App-Napped.
    const create = source.indexOf("runStep('createWindow', createWindow)", begin)
    expect(create).toBeGreaterThan(start)
    const resume = source.indexOf('resumeBackfillIfPending()')
    const timer = source.lastIndexOf('setTimeout(() => {', resume)
    const slice = source.slice(timer, source.indexOf('}, 15_000)', resume) + '}, 15_000)'.length)
    const stop = slice.indexOf('setBootPowerSaveBlock(false)')
    const clear = slice.indexOf("clearBootWatchOnce('mqa-175')")
    expect(stop).toBeGreaterThan(-1)
    expect(clear).toBeGreaterThan(stop) // stop power-save with the 15s backstop clear
    // Brain resume still inside the 15s timer (MQA-175).
    expect(slice.indexOf('resumeBackfillIfPending()')).toBeGreaterThan(-1)
    const willQuit = source.indexOf("app.on('will-quit'")
    const willSlice = source.slice(willQuit, willQuit + 900)
    expect(willSlice).toMatch(/setBootPowerSaveBlock\(false\)/)
    expect(willSlice).toMatch(/endBootWatch\(/)
    expect(source).toMatch(/bootPowerSaveBlockerId/)
    expect(source).toMatch(/powerSaveBlocker\.start\('prevent-app-suspension'\)/)
  })

  it('FITO-185-E: 15s boot callback clears watch in finally even if brain resume throws', () => {
    // Hardprove left boot-incomplete.json stuck when resumeBackfillIfPending (or a sibling) threw —
    // the clear sat after the brain work with no finally. Contract: try/finally around the 15s body,
    // per-step try/catch on each brain call, and clearBootWatchOnce('mqa-175') in finally (audits inside).
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    const resume = source.indexOf('resumeBackfillIfPending()')
    expect(resume).toBeGreaterThan(-1)
    // Walk back to the setTimeout that owns this resume (the 15s MQA-175 timer).
    const timer = source.lastIndexOf('setTimeout(() => {', resume)
    expect(timer).toBeGreaterThan(-1)
    const slice = source.slice(timer, source.indexOf('}, 15_000)', resume) + '}, 15_000)'.length)
    expect(slice).toMatch(/try\s*\{/)
    expect(slice).toMatch(/finally\s*\{/)
    const finallyIdx = slice.indexOf('finally')
    const finallyBody = slice.slice(finallyIdx)
    expect(finallyBody).toMatch(/setBootPowerSaveBlock\(false\)/)
    expect(finallyBody).toMatch(/clearBootWatchOnce\('mqa-175'\)/)
    // Power-save stop + sentinel clear live in finally (after any resume throw path), not only the happy path.
    expect(finallyBody.indexOf('setBootPowerSaveBlock(false)')).toBeLessThan(finallyBody.indexOf("clearBootWatchOnce('mqa-175')"))
    // Per-step isolation around the brain resume calls (sync throws must not skip finally or siblings).
    for (const step of [
      'resumeBackfillIfPending',
      'reconcileMeetingsInBackground',
      'wireIntelligenceIndexWork',
      'catchUpIntelligenceIndexIfNeeded',
      'scheduleIntelligenceIndex',
      'runConsolidationIfDue'
    ]) {
      expect(slice, step).toMatch(new RegExp(`try\\s*\\{[\\s\\S]*?${step}`))
    }
    // earlyDeath safe-start skip preserved (MQA-175).
    expect(slice).toMatch(/if \(earlyDeath\)/)
    expect(slice).toMatch(/safe start/)
  })

  it('FITO-185-G-SHOW+G-TIMER: early sentinel clear past kill zone + exclusive 2s reveal', () => {
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    expect(source).toMatch(/const clearBootWatchOnce = \(reason: string\): void =>/)
    expect(source).toMatch(/auditLog\('app\.boot\.watch_cleared',\s*\{\s*earlyDeath:\s*Boolean\(earlyDeath\),\s*reason\s*\}\)/)
    expect(source).toMatch(/clearBootWatchOnce\('createWindow'\)/)
    expect(source).toMatch(/clearBootWatchOnce\('registerIpc'\)/)
    // FITO-185-X: IPC handlers before loadURL
    const ipcStep = source.indexOf("runStep('registerIpc', registerIpc)")
    const winStep = source.indexOf("runStep('createWindow', createWindow)")
    expect(ipcStep).toBeGreaterThan(-1)
    expect(winStep).toBeGreaterThan(ipcStep)
    expect(source).toMatch(/setImmediate\(\(\) => clearBootWatchOnce\('setImmediate'\)\)/)
    expect(source).toMatch(/powerMonitor\.on\('unlock-screen'/)
    // Exclusive hard reveal at 2s
    const create = source.slice(source.indexOf('function createWindow'), source.indexOf('function resizeTo'))
    expect(create).toMatch(/revealExclusiveWhenPainted/)
    expect(create).toContain('}, 2000)') // FITO-185-G-SHOW hard reveal
    // Brain work still only on 15s timer (not moved earlier)
    const resume = source.indexOf('resumeBackfillIfPending()')
    const fifteen = source.indexOf('}, 15_000)', resume)
    expect(fifteen).toBeGreaterThan(resume)
  })

  it('FITO-185-F: createTray audits success/failure and always sets a darwin title', () => {
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    const start = source.indexOf('function createTray(): void {')
    expect(start).toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('\nfunction rebuildTrayMenu(', start))
    expect(body).toMatch(/auditLog\('tray\.created',\s*\{\s*emptyIcon\s*\}\)/)
    expect(body).toMatch(/auditLog\('tray\.failed',\s*\{\s*message:/)
    // No silent empty catch — failure must carry a message into the audit trail.
    expect(body).not.toMatch(/catch\s*\{\s*\/\*\s*tray optional\s*\*\//)
    expect(body).toMatch(/process\.platform === 'darwin'\)\s*tray\.setTitle\(' ◉ Métis'\)/)
  })
})
