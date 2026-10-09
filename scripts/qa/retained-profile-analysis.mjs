// One investigation over retained bytes. No installer, app, historical module, or raw diagnostic is run/uploaded.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stopOwnedChild } from './lib/st-1-termination.mjs'

const REPOSITORY = 'mysticalsin/AskToto-Mantu'
const REPOSITORY_ID = 1282463398
const REPORT = 'st-1-macos-fifo-history.json'
const PROFILE = 'st-1-macos-fifo-history.cpuprofile'
const INSTALLER = 'Metis-QA-1.9.7.zip'
const OUTPUT = 'retained-profile-summary.json'
const CAPS = Object.freeze({ [REPORT]: 2 * 1024 ** 2, [PROFILE]: 8 * 1024 ** 2 })
const RESERVE_MS = 10_000
const CATEGORIES = Object.freeze([
  'idle',
  'program',
  'gc',
  'window-create-view',
  'other-native-view',
  'tray-create',
  'tray-decorate',
  'sync-fs',
  'other'
])

export const SOURCES = Object.freeze([
  Object.freeze({
    run: 37759977579,
    head: 'a0be15bda4941d33997a9414ce2ee199910053db',
    commit: '325a5822c77d28ab6aba02efbe2aaf65aee5efd0',
    producerJob: 113253857028,
    historyJob: 113262466483,
    qaSha: 'b0730716ac47181b15deeabc1f8365e8ff0be8c8a9d86fa9df6ac3083608bb19',
    inclusive: false,
    history: Object.freeze({
      id: 11543780356,
      name: 'st-1-macos-history',
      size: 89028,
      sha: '2cb853de87b97de5a5b4f8a1e6d5caec3d7817c7975ddbc6c7be146ecddb38be'
    }),
    provenance: Object.freeze({
      id: 11542109790,
      name: 'candidate-provenance',
      size: 1459,
      sha: '87e67524b5d0cf6a0592513a4a6a3d015afeba9540cea524a686d753ef659fee'
    })
  }),
  Object.freeze({
    run: 37780722264,
    head: '299f286b7856c08b89c7ac228c9d68fffbd4753f',
    commit: '990fba1abcb5ecd4a7a4c4aec3f079ddb3089f7c',
    producerJob: 113322970992,
    historyJob: 113331807071,
    qaSha: '384f2d67a2baec0fec1bba9cfd332b6e2b50b24196ee36b0b3efd0933f7b3465',
    inclusive: true,
    history: Object.freeze({
      id: 11553128459,
      name: 'st-1-macos-history',
      size: 107262,
      sha: '7c6761478ed91d8f892b5983911609a48ea7df202e4f0fbc11d83bbedab1ca07'
    }),
    provenance: Object.freeze({
      id: 11552309594,
      name: 'candidate-provenance',
      size: 1455,
      sha: '0afa3e4e152f85cac87020ba84e4ecc1865dc11b5cf81fc584b54f245661dd3f'
    })
  })
])

const FAILURES = new Set([
  'analysis-failed',
  'deadline',
  'metadata-mismatch',
  'checkout-mismatch',
  'archive-mismatch',
  'provenance-mismatch',
  'report-mismatch',
  'report-scope-mismatch',
  'profile-invalid',
  'json-invalid',
  'manifest-invalid',
  'member-invalid',
  'native-failed',
  'native-overflow',
  'native-unacknowledged',
  'transport-failed',
  'transport-overflow',
  'redirect-invalid',
  'summary-invalid',
  'owner-state-invalid',
  'canary-failed'
])
class DiagnosticFailure extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}
const fail = (code) => {
  throw new DiagnosticFailure(code)
}
const requireValue = (condition, code) => {
  if (!condition) fail(code)
}
export const closedFailure = (error) =>
  error instanceof DiagnosticFailure && FAILURES.has(error.code) ? error.code : 'analysis-failed'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) =>
  plain(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const finite = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
const integer = (value) => Number.isSafeInteger(value) && value >= 0
const text = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
const remaining = (deadline, now, reserve = 0) => Math.max(0, deadline - now() - reserve)

export function decodeJson(bytes, cap) {
  try {
    requireValue(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= cap, 'json-invalid')
    return JSON.parse(text(bytes))
  } catch {
    fail('json-invalid')
  }
}

export function verifyRun(value, s) {
  requireValue(
    value?.id === s.run &&
      value.path === '.github/workflows/qa-candidate.yml' &&
      value.event === 'pull_request' &&
      value.run_attempt === 1 &&
      value.status === 'completed' &&
      value.conclusion === 'success' &&
      value.head_sha === s.head &&
      [value.repository, value.head_repository].every((r) => r?.id === REPOSITORY_ID && r.full_name === REPOSITORY),
    'metadata-mismatch'
  )
}

export function verifyJob(value, id, name, s) {
  requireValue(
    value?.id === id &&
      value.name === name &&
      value.run_id === s.run &&
      value.head_sha === s.head &&
      value.status === 'completed' &&
      value.conclusion === 'success',
    'metadata-mismatch'
  )
}

export function verifyArtifact(value, a, s) {
  const run = value?.workflow_run
  requireValue(
    value?.id === a.id &&
      value.name === a.name &&
      value.size_in_bytes === a.size &&
      value.digest === `sha256:${a.sha}` &&
      value.expired === false &&
      run?.id === s.run &&
      run.repository_id === REPOSITORY_ID &&
      run.head_repository_id === REPOSITORY_ID &&
      run.head_sha === s.head,
    'metadata-mismatch'
  )
}

export function checkoutReceipt(log, s) {
  const lines = log.split(/\r?\n/)
  const command = /^\d{4}-\d\d-\d\dT\S+ \[command\]\/opt\/homebrew\/bin\/git log -1 --format=%H$/
  const indices = lines.flatMap((line, index) => (command.test(line) ? [index] : []))
  requireValue(indices.length === 1, 'checkout-mismatch')
  const match = /^\d{4}-\d\d-\d\dT\S+ ([a-f0-9]{40})$/.exec(lines[indices[0] + 1] ?? '')
  requireValue(match?.[1] === s.commit, 'checkout-mismatch')
  return s.commit
}

export function verifyProvenance(p, s) {
  requireValue(
    p?.schema === 1 &&
      p.repository === REPOSITORY &&
      p.run?.id === s.run &&
      p.commit === s.commit &&
      p.version === '1.9.7' &&
      Array.isArray(p.builds) &&
      p.builds.length <= 8,
    'provenance-mismatch'
  )
  const builds = p.builds.filter((b) => b?.variant === 'mac-qa-identity')
  const asset = builds[0]?.assets?.[0]
  requireValue(
    builds.length === 1 &&
      Array.isArray(builds[0].assets) &&
      builds[0].assets.length === 1 &&
      asset?.name === INSTALLER &&
      asset.sha256 === s.qaSha &&
      integer(asset.size) &&
      asset.size > 0,
    'provenance-mismatch'
  )
}

/** Only the fixed GitHub API origin receives credentials. Signed redirects are never logged. */
export async function getBytes(route, { cap, deadline, token, fetchFn = fetch, now = () => performance.now() }) {
  requireValue(/^(runs\/\d+|jobs\/\d+(\/logs)?|artifacts\/\d+(\/zip)?)$/.test(route), 'transport-failed')
  const timeout = Math.min(20_000, remaining(deadline, now, RESERVE_MS))
  requireValue(timeout > 0 && integer(cap) && cap > 0, 'deadline')
  const controller = new AbortController()
  let reader
  let timer
  let complete = false
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new DiagnosticFailure('deadline'))
    }, timeout)
  })
  const active = () => requireValue(!controller.signal.aborted, 'deadline')
  const work = async () => {
    const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 'metis-retained-profile-analysis' }
    let response = await fetchFn(`https://api.github.com/repos/${REPOSITORY}/actions/${route}`, {
      headers,
      redirect: 'manual',
      signal: controller.signal
    })
    active()
    if (route.endsWith('/zip')) requireValue(response.status === 302, 'redirect-invalid')
    if (response.status === 302) {
      requireValue(/\/(zip|logs)$/.test(route), 'redirect-invalid')
      let url
      try {
        url = new URL(response.headers.get('location'))
      } catch {
        fail('redirect-invalid')
      }
      requireValue(
        url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash,
        'redirect-invalid'
      )
      await response.body?.cancel()
      active()
      response = await fetchFn(url.href, {
        headers: { 'User-Agent': 'metis-retained-profile-analysis' },
        redirect: 'manual',
        signal: controller.signal
      })
      active()
    }
    requireValue(response.status === 200 && response.body, 'transport-failed')
    const length = response.headers.get('content-length')
    requireValue(length === null || (/^\d+$/.test(length) && Number(length) <= cap), 'transport-overflow')
    reader = response.body.getReader()
    const chunks = []
    let size = 0
    while (true) {
      const { value, done } = await reader.read()
      active()
      if (done) break
      size += value.byteLength
      requireValue(size <= cap, 'transport-overflow')
      chunks.push(Buffer.from(value))
    }
    complete = true
    return Buffer.concat(chunks, size)
  }
  try {
    return await Promise.race([work(), expired])
  } catch (error) {
    fail(error instanceof DiagnosticFailure ? error.code : 'transport-failed')
  } finally {
    clearTimeout(timer)
    controller.abort()
    if (reader && !complete) {
      let cancelTimer
      try {
        await Promise.race([
          reader.cancel().catch(() => {}),
          new Promise((resolve) => {
            cancelTimer = setTimeout(resolve, Math.min(1000, remaining(deadline, now)))
          })
        ])
      } finally {
        clearTimeout(cancelTimer)
      }
    }
    if (complete) reader?.releaseLock()
  }
}

/**
 * @typedef {Pick<import('node:events').EventEmitter, 'on' | 'once' | 'off'> & {
 *   pid?: number, exitCode: number | null, signalCode: string | null,
 *   stdout: Pick<import('node:events').EventEmitter, 'on' | 'off'> | null
 * }} NativeChild
 * @typedef {{ cwd?: string, cap: number, deadline: number, now?: () => number,
 *   spawnFn?: (file: string, args: string[], options: import('node:child_process').SpawnOptions) => NativeChild,
 *   stop?: (child: NativeChild, options: { timeoutMs: number, platform: 'linux' }) => Promise<{ state: string }>
 * }} NativeOptions
 */

/** Linux-only fixed tool. Success needs root exit, pipe close and detached-group absence.
 * @param {string[]} args
 * @param {NativeOptions} options
 */
export async function runUnzip(
  args,
  { cwd, cap, deadline, now = () => performance.now(), spawnFn = spawn, stop = stopOwnedChild }
) {
  const timeout = Math.min(10_000, remaining(deadline, now, RESERVE_MS))
  requireValue(timeout > 0, 'deadline')
  let child
  try {
    child = spawnFn('/usr/bin/unzip', args, {
      cwd,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' }
    })
  } catch {
    fail('native-failed')
  }
  let failure = null
  let closed = false
  let size = 0
  const chunks = []
  let finish
  let closeResolve
  const outcome = new Promise((resolve) => {
    finish = resolve
  })
  const closure = new Promise((resolve) => {
    closeResolve = resolve
  })
  const reject = (code) => {
    failure ??= code
    finish()
  }
  const onData = (chunk) => {
    if (failure) return
    size += chunk.byteLength
    if (size > cap) {
      reject('native-overflow')
      return
    }
    chunks.push(Buffer.from(chunk))
  }
  const onError = () => reject('native-failed')
  const onClose = (code, signal) => {
    closed = true
    if (code !== 0 || signal) failure ??= 'native-failed'
    closeResolve()
    finish()
  }
  child.on('error', onError)
  child.on('close', onClose)
  child.stdout?.on('data', onData)
  child.stdout?.on('error', onError)
  const timer = setTimeout(() => reject('deadline'), timeout)
  let closeTimer
  try {
    if (!child.stdout) reject('native-failed')
    await outcome
    clearTimeout(timer)
    const receipt = await stop(child, { timeoutMs: Math.min(5000, remaining(deadline, now)), platform: 'linux' })
    requireValue(receipt?.state === 'acknowledged', 'native-unacknowledged')
    if (!closed) {
      await Promise.race([
        closure,
        new Promise((resolve) => {
          closeTimer = setTimeout(resolve, Math.min(1000, remaining(deadline, now)))
        })
      ])
    }
    requireValue(closed, 'native-unacknowledged')
    if (failure) fail(failure)
    return Buffer.concat(chunks, size)
  } catch (error) {
    if (!(error instanceof DiagnosticFailure)) fail('native-unacknowledged')
    throw error
  } finally {
    clearTimeout(timer)
    clearTimeout(closeTimer)
    child.off('error', onError)
    child.off('close', onClose)
    child.stdout?.off('data', onData)
    child.stdout?.off('error', onError)
    if (!closed) {
      // An uncertain child/pipe remains owned. Suppress raw late errors until its terminal close.
      const silence = () => {}
      const dispose = () => {
        child.off('error', silence)
        child.stdout?.off('error', silence)
      }
      child.on('error', silence)
      child.stdout?.on('error', silence)
      child.once('close', dispose)
    }
  }
}

export function manifestNames(listing, selected) {
  requireValue(typeof listing === 'string' && listing.endsWith('\n'), 'manifest-invalid')
  const names = listing.slice(0, -1).split('\n')
  requireValue(names.length > 0 && names.length <= 32, 'manifest-invalid')
  const seen = new Set()
  for (const name of names) {
    const segments = name.replace(/\/$/, '').split('/')
    requireValue(
      name.length <= 256 &&
        /^[A-Za-z0-9_./-]+$/.test(name) &&
        segments.every((part) => part && part !== '.' && part !== '..') &&
        !seen.has(name.toLowerCase()),
      'manifest-invalid'
    )
    seen.add(name.toLowerCase())
  }
  requireValue(selected.every((name) => names.filter((n) => n === name).length === 1), 'manifest-invalid')
  return names
}

export function selectedSizes(listing, caps) {
  requireValue(typeof listing === 'string' && listing.endsWith('\n'), 'member-invalid')
  const rows = listing.slice(0, -1).split('\n')
  requireValue(rows.length === Object.keys(caps).length, 'member-invalid')
  const sizes = Object.create(null)
  for (const row of rows) {
    const fields = row.trim().split(/\s+/)
    const [mode, version, host, size, flags, compressed, method, date, time, name] = fields
    requireValue(
      fields.length === 10 &&
        /^-[rwxstSTadh-]{5,10}$/.test(mode) &&
        /^\d\.\d$/.test(version) &&
        ['unx', 'fat'].includes(host) &&
        /^\d+$/.test(size) &&
        /^[tb][-lxX]$/.test(flags) &&
        /^\d+$/.test(compressed) &&
        /^(stor|def[NSFX])$/.test(method) &&
        /^\S+$/.test(date) &&
        /^\d\d:\d\d$/.test(time) &&
        Object.hasOwn(caps, name) &&
        !Object.hasOwn(sizes, name) &&
        Number.isSafeInteger(Number(size)) &&
        Number(size) > 0 &&
        Number(size) <= caps[name],
      'member-invalid'
    )
    sizes[name] = Number(size)
  }
  return { ...sizes }
}

export function verifyArchiveBytes(bytes, expected) {
  requireValue(bytes.length === expected.size && hash(bytes) === expected.sha, 'archive-mismatch')
}

function ownedArchive(path, expected) {
  const stat = lstatSync(path)
  requireValue(stat.isFile() && stat.nlink === 1 && stat.size === expected.size, 'archive-mismatch')
  const bytes = readFileSync(path)
  verifyArchiveBytes(bytes, expected)
}

async function readMembers(path, caps, expected, dir, deadline) {
  const run = (args, cap) => {
    ownedArchive(path, expected)
    return runUnzip(args, { cwd: dir, cap, deadline })
  }
  const names = Object.keys(caps)
  manifestNames(text(await run(['-Z', '-1', path], 16 * 1024)), names)
  // Explicit member selection suppresses headers/totals; unexpected native output is not ignored.
  const sizes = selectedSizes(text(await run(['-Z', '-l', path, ...names], 16 * 1024)), caps)
  const result = Object.create(null)
  for (const name of names) {
    const bytes = await run(['-p', path, name], caps[name])
    requireValue(bytes.length === sizes[name], 'member-invalid')
    result[name] = { value: decodeJson(bytes, caps[name]), sha: hash(bytes) }
  }
  return result
}

// Tiny stored ZIP producer for synthetic canaries only; never used to parse retained data.
function canaryZip(entries, badCrc = false) {
  const locals = []
  const central = []
  let offset = 0
  for (const { name, body, mode = 0o100600 } of entries) {
    const filename = Buffer.from(name)
    const bytes = Buffer.from(body)
    let crc = 0xffffffff
    for (const byte of bytes) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    crc = ((crc ^ 0xffffffff) + (badCrc ? 1 : 0)) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(33, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(bytes.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(filename.length, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50)
    entry.writeUInt16LE(0x0314, 4)
    local.copy(entry, 6, 4, 28)
    entry.writeUInt32LE((mode << 16) >>> 0, 38)
    entry.writeUInt32LE(offset, 42)
    locals.push(local, filename, bytes)
    central.push(entry, filename)
    offset += local.length + filename.length + bytes.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

export async function nativeCanary(dir, deadline) {
  const version = await runUnzip(['-v'], { cwd: dir, cap: 8192, deadline })
  requireValue(text(version).startsWith('UnZip 6.00 of 20 April 2009, by Info-ZIP.'), 'canary-failed')
  const clean = [
    { name: 'canary.json', body: '{"ok":true}' },
    { name: 'ignored.txt', body: 'not selected' }
  ]
  const fixtures = [
    { name: 'canary-clean.zip', bytes: canaryZip(clean), rejection: null },
    {
      name: 'canary-path.zip',
      bytes: canaryZip([...clean, { name: '../escape', body: 'ignored' }]),
      rejection: 'manifest-invalid'
    },
    {
      name: 'canary-link.zip',
      bytes: canaryZip([{ name: 'canary.json', body: 'outside', mode: 0o120777 }]),
      rejection: 'member-invalid'
    },
    { name: 'canary-crc.zip', bytes: canaryZip(clean, true), rejection: 'native-failed' }
  ]
  const before = readdirSync(dir)
  for (const fixture of fixtures) {
    const path = join(dir, fixture.name)
    writeFileSync(path, fixture.bytes, { flag: 'wx', mode: 0o600 })
    try {
      const selected = await readMembers(
        path,
        { 'canary.json': 1024 },
        { size: fixture.bytes.length, sha: hash(fixture.bytes) },
        dir,
        deadline
      )
      requireValue(
        fixture.rejection === null &&
          exact(selected['canary.json'].value, ['ok']) &&
          selected['canary.json'].value.ok === true,
        'canary-failed'
      )
    } catch (error) {
      if (closedFailure(error) !== fixture.rejection) throw error
    }
  }
  const expected = [...before, ...fixtures.map((f) => f.name)].sort()
  requireValue(JSON.stringify(readdirSync(dir).sort()) === JSON.stringify(expected), 'canary-failed')
}

function sampleProjection(sample, index) {
  if (!sample) return null
  return Object.fromEntries([
    ['index', index],
    ...['tMs', 'answeredMs', 'writeMs', 'lookupMs', 'runLoopMaxMs', 'loopMaxDuringWriteMs', 'loopMaxSinceLastMs'].map(
      (key) => [key, sample[key] ?? null]
    )
  ])
}

export function summarizeReport(r, s) {
  requireValue(
    r?.harness === 'ST-1' &&
      r.row === 'fifo' &&
      r.platform === 'darwin' &&
      r.arch === 'arm64' &&
      r.historyRow === true &&
      r.historyMode === 'on' &&
      r.build_run_id === s.run &&
      r.artifact_sha256 === s.qaSha &&
      r.installer === INSTALLER &&
      r.complete === true &&
      r.verdict === 'FAIL' &&
      exact(r.teardown, ['state']) &&
      r.teardown.state === 'acknowledged',
    'report-mismatch'
  )
  const p = r.cpuProfile
  requireValue(
    p?.file === PROFILE &&
      p.running === false &&
      !p.error &&
      [p.requestedAtMs, p.answeredAtMs, p.startedAtMs, p.stoppedAtMs].every(finite) &&
      p.requestedAtMs <= p.answeredAtMs &&
      p.startedAtMs === p.answeredAtMs &&
      p.answeredAtMs < p.stoppedAtMs &&
      Array.isArray(r.timeline) &&
      r.timeline.length > 0 &&
      r.timeline.length <= 512 &&
      Array.isArray(r.history) &&
      r.history.length > 0 &&
      r.history.length <= 512 &&
      [r.loop?.maxMs, r.loop?.p99Ms].every(finite),
    'report-mismatch'
  )
  let previous = -1
  for (const sample of r.timeline) {
    requireValue(
      plain(sample) &&
        finite(sample.tMs) &&
        sample.tMs >= previous &&
        (sample.late === undefined || sample.late === true) &&
        (sample.hung === undefined || sample.hung === true),
      'report-mismatch'
    )
    previous = sample.tMs
    for (const key of [
      'answeredMs',
      'writeMs',
      'lookupMs',
      'runLoopMaxMs',
      'loopMaxDuringWriteMs',
      'loopMaxSinceLastMs'
    ]) {
      requireValue(sample[key] === undefined || finite(sample[key]), 'report-mismatch')
    }
    requireValue(
      sample.hung
        ? sample.late === true && sample.writeMs === undefined && sample.lookupMs === undefined
        : finite(sample.answeredMs) && finite(sample.writeMs) && finite(sample.lookupMs),
      'report-mismatch'
    )
  }
  const timely = r.timeline.filter((sample) => !sample.late)
  const late = r.timeline.filter((sample) => sample.late)
  requireValue(r.samples === timely.length && r.lateSamples === late.length, 'report-scope-mismatch')
  const values = (rows, key) => rows.map((sample) => sample[key]).filter(finite)
  const maximum = (list) => (list.length ? Math.max(...list) : null)
  const allWrite = values(r.timeline, 'writeMs')
  const allLookup = values(r.timeline, 'lookupMs')
  const timelyWrite = values(timely, 'writeMs')
  const timelyLookup = values(timely, 'lookupMs')
  requireValue(
    r.write?.maxMs === (maximum(timelyWrite) ?? 0) && r.lookup?.maxMs === (maximum(timelyLookup) ?? 0),
    'report-scope-mismatch'
  )
  if (s.inclusive) {
    requireValue(
      r.allResponseIo?.write?.maxMs === maximum(allWrite) &&
        r.allResponseIo.write.observedSamples === allWrite.length &&
        r.allResponseIo?.lookup?.maxMs === maximum(allLookup) &&
        r.allResponseIo.lookup.observedSamples === allLookup.length,
      'report-scope-mismatch'
    )
  } else requireValue(r.allResponseIo === undefined, 'report-scope-mismatch')
  requireValue(
    r.history.every((h, index) => finite(h?.tMs) && (index === 0 || h.tMs >= r.history[index - 1].tMs)),
    'report-mismatch'
  )
  const runMax = maximum(values(r.timeline, 'runLoopMaxMs'))
  const peak = r.timeline.findIndex((sample) => sample.runLoopMaxMs === runMax)
  const firstLate = r.timeline.findIndex((sample) => sample.late)
  return {
    originalVerdict: 'FAIL',
    timelyCount: timely.length,
    lateCount: late.length,
    timelyWriteMaxMs: maximum(timelyWrite),
    timelyLookupMaxMs: maximum(timelyLookup),
    allWriteMaxMs: maximum(allWrite),
    allLookupMaxMs: maximum(allLookup),
    allWriteCount: allWrite.length,
    allLookupCount: allLookup.length,
    loopMaxMs: r.loop.maxMs,
    loopP99Ms: r.loop.p99Ms,
    observedRunLoopMaxMs: runMax,
    firstHistoryMs: r.history[0].tMs,
    profilerRequestedMs: p.requestedAtMs,
    profilerAnsweredMs: p.answeredAtMs,
    profilerStoppedMs: p.stoppedAtMs,
    firstSample: sampleProjection(r.timeline[0], 0),
    firstLate: sampleProjection(r.timeline[firstLate], firstLate),
    peakObservation: sampleProjection(r.timeline[peak], peak)
  }
}

export function summarizeProfile(p, receipt, report) {
  requireValue(
    plain(p) &&
      integer(p.startTime) &&
      integer(p.endTime) &&
      p.endTime > p.startTime &&
      Array.isArray(p.nodes) &&
      p.nodes.length > 0 &&
      p.nodes.length <= 25_000 &&
      Array.isArray(p.samples) &&
      p.samples.length > 0 &&
      p.samples.length <= 100_000 &&
      Array.isArray(p.timeDeltas) &&
      p.timeDeltas.length === p.samples.length &&
      finite(receipt?.requestedAtMs) &&
      finite(receipt?.answeredAtMs) &&
      receipt.requestedAtMs <= receipt.answeredAtMs,
    'profile-invalid'
  )
  const nodes = new Map()
  const parent = new Map()
  for (const node of p.nodes) {
    requireValue(
      integer(node?.id) &&
        node.id > 0 &&
        !nodes.has(node.id) &&
        plain(node.callFrame) &&
        typeof node.callFrame.functionName === 'string' &&
        node.callFrame.functionName.length <= 1024 &&
        typeof node.callFrame.url === 'string' &&
        node.callFrame.url.length <= 4096 &&
        (node.children === undefined || (Array.isArray(node.children) && node.children.length <= 25_000)),
      'profile-invalid'
    )
    nodes.set(node.id, node)
    for (const child of node.children ?? []) {
      requireValue(integer(child) && !parent.has(child), 'profile-invalid')
      parent.set(child, node.id)
    }
  }
  const roots = p.nodes.filter((node) => !parent.has(node.id))
  requireValue(
    roots.length === 1 &&
      roots[0].callFrame.functionName === '(root)' &&
      [...parent.keys()].every((id) => nodes.has(id)),
    'profile-invalid'
  )
  const categoryById = new Map()
  for (const node of p.nodes) {
    const names = []
    const seen = new Set()
    let id = node.id
    while (id !== undefined) {
      requireValue(!seen.has(id) && names.length < 128 && nodes.has(id), 'profile-invalid')
      seen.add(id)
      names.push(nodes.get(id).callFrame.functionName)
      id = parent.get(id)
    }
    const leaf = names[0]
    let category = 'other'
    if (leaf === '(idle)') category = 'idle'
    else if (leaf === '(program)') category = 'program'
    else if (leaf === '(garbage collector)') category = 'gc'
    else if (leaf === 'View' && names.includes('createWindow') && names.includes('withBootFirstShowDeferred')) {
      category = 'window-create-view'
    } else if (leaf === 'View' && names.includes('view')) category = 'other-native-view'
    else if (leaf === 'create' && names.includes('timeBootStage')) category = 'tray-create'
    else if (leaf === 'decorate' && names.includes('timeBootStage')) category = 'tray-decorate'
    else if (['statSync', 'writeFileUtf8', 'readFileSync', 'writeFileSync'].includes(leaf)) category = 'sync-fs'
    categoryById.set(node.id, CATEGORIES.indexOf(category))
  }
  const categories = CATEGORIES.map((category) => ({
    category,
    samples: 0,
    deltaUs: 0,
    firstOffsetUs: null,
    lastOffsetUs: null,
    firstAppIntervalMs: null,
    lastAppIntervalMs: null
  }))
  const bins = Array.from({ length: 20 }, () => CATEGORIES.map(() => [0, 0]))
  const observations = [report?.firstLate, report?.peakObservation].map((sample) => {
    if (!sample || !finite(sample.answeredMs)) return null
    requireValue(finite(sample.tMs + sample.answeredMs), 'profile-invalid')
    return {
      intervalMs: [sample.tMs, sample.tMs + sample.answeredMs],
      categories: CATEGORIES.map(() => [0, 0])
    }
  })
  let offset = 0
  for (let i = 0; i < p.samples.length; i++) {
    const delta = p.timeDeltas[i]
    const index = categoryById.get(p.samples[i])
    requireValue(integer(delta) && index !== undefined && Number.isSafeInteger(offset + delta), 'profile-invalid')
    offset += delta
    const row = categories[index]
    row.samples++
    row.deltaUs += delta
    row.firstOffsetUs ??= offset
    row.lastOffsetUs = offset
    const bin = Math.floor(offset / 500_000)
    if (bin < bins.length) {
      bins[bin][index][0]++
      bins[bin][index][1] += delta
    }
    // Possible overlap of endpoint uncertainty and request/response interval, not causal execution time.
    for (const observation of observations) {
      if (
        observation &&
        receipt.requestedAtMs + offset / 1000 <= observation.intervalMs[1] &&
        receipt.answeredAtMs + offset / 1000 >= observation.intervalMs[0]
      ) {
        observation.categories[index][0]++
        observation.categories[index][1] += delta
      }
    }
  }
  requireValue(offset <= p.endTime - p.startTime, 'profile-invalid')
  for (const row of categories) {
    if (row.firstOffsetUs === null) continue
    row.firstAppIntervalMs = [
      receipt.requestedAtMs + row.firstOffsetUs / 1000,
      receipt.answeredAtMs + row.firstOffsetUs / 1000
    ]
    row.lastAppIntervalMs = [
      receipt.requestedAtMs + row.lastOffsetUs / 1000,
      receipt.answeredAtMs + row.lastOffsetUs / 1000
    ]
  }
  return {
    durationUs: p.endTime - p.startTime,
    deltaUs: offset,
    residualUs: p.endTime - p.startTime - offset,
    samples: p.samples.length,
    categories,
    bins,
    firstLateOverlap: observations[0],
    peakReceiptOverlap: observations[1]
  }
}

const REPORT_NUMBERS = [
  'timelyCount',
  'lateCount',
  'timelyWriteMaxMs',
  'timelyLookupMaxMs',
  'allWriteMaxMs',
  'allLookupMaxMs',
  'allWriteCount',
  'allLookupCount',
  'loopMaxMs',
  'loopP99Ms',
  'observedRunLoopMaxMs',
  'firstHistoryMs',
  'profilerRequestedMs',
  'profilerAnsweredMs',
  'profilerStoppedMs'
]
const SAMPLE_NUMBERS = [
  'index',
  'tMs',
  'answeredMs',
  'writeMs',
  'lookupMs',
  'runLoopMaxMs',
  'loopMaxDuringWriteMs',
  'loopMaxSinceLastMs'
]
const sampleValid = (s) =>
  s === null || (exact(s, SAMPLE_NUMBERS) && SAMPLE_NUMBERS.every((key) => s[key] === null || finite(s[key])))
const nullableNumber = (n) => n === null || finite(n)
const intervalValid = (a) =>
  a === null || (Array.isArray(a) && a.length === 2 && a.every(finite) && a[0] <= a[1])
const countsValid = (cells) =>
  Array.isArray(cells) &&
  cells.length === CATEGORIES.length &&
  cells.every((cell) => Array.isArray(cell) && cell.length === 2 && cell.every(integer))
const overlapValid = (value) =>
  value === null ||
  (exact(value, ['intervalMs', 'categories']) &&
    value.intervalMs !== null &&
    intervalValid(value.intervalMs) &&
    countsValid(value.categories))

/** Exact closed output schema, applied again to disk bytes before publication. */
export function validateSummary(value) {
  requireValue(
    exact(value, [
      'schema',
      'causalConclusion',
      'preProfileCause',
      'instrumentation',
      'binConvention',
      'applicationRerun',
      'st1Evidence',
      'promotable',
      'sources'
    ]) &&
      value.schema === 1 &&
      value.causalConclusion === 'not-established' &&
      value.preProfileCause === 'unknown' &&
      value.instrumentation === 'startup-and-profiler-included' &&
      value.binConvention === 'sample-endpoint' &&
      value.applicationRerun === false &&
      value.st1Evidence === false &&
      value.promotable === false &&
      Array.isArray(value.sources) &&
      value.sources.length === SOURCES.length,
    'summary-invalid'
  )
  for (const [index, item] of value.sources.entries()) {
    const s = SOURCES[index]
    requireValue(
      exact(item, [
        'run',
        'harnessCommit',
        'historyArtifact',
        'provenanceArtifact',
        'historyArchiveSha256',
        'provenanceArchiveSha256',
        'qaSha256',
        'binding',
        'members',
        'report',
        'profile'
      ]) &&
        item.run === s.run &&
        item.harnessCommit === s.commit &&
        item.historyArtifact === s.history.id &&
        item.provenanceArtifact === s.provenance.id &&
        item.historyArchiveSha256 === s.history.sha &&
        item.provenanceArchiveSha256 === s.provenance.sha &&
        item.qaSha256 === s.qaSha &&
        item.binding === 'historical-provenance-report-only' &&
        exact(item.members, ['report', 'profile', 'provenance']) &&
        Object.values(item.members).every((sha) => typeof sha === 'string' && /^[a-f0-9]{64}$/.test(sha)),
      'summary-invalid'
    )
    const r = item.report
    requireValue(
      exact(r, ['originalVerdict', ...REPORT_NUMBERS, 'firstSample', 'firstLate', 'peakObservation']) &&
        r.originalVerdict === 'FAIL' &&
        REPORT_NUMBERS.every((key) => nullableNumber(r[key])) &&
        [r.firstSample, r.firstLate, r.peakObservation].every(sampleValid),
      'summary-invalid'
    )
    const p = item.profile
    requireValue(
      exact(p, [
        'durationUs',
        'deltaUs',
        'residualUs',
        'samples',
        'categories',
        'bins',
        'firstLateOverlap',
        'peakReceiptOverlap'
      ]) &&
        ['durationUs', 'deltaUs', 'residualUs', 'samples'].every((key) => integer(p[key])) &&
        Array.isArray(p.categories) &&
        p.categories.length === CATEGORIES.length &&
        Array.isArray(p.bins) &&
        p.bins.length === 20 &&
        overlapValid(p.firstLateOverlap) &&
        overlapValid(p.peakReceiptOverlap),
      'summary-invalid'
    )
    for (const [i, row] of p.categories.entries()) {
      requireValue(
        exact(row, [
          'category',
          'samples',
          'deltaUs',
          'firstOffsetUs',
          'lastOffsetUs',
          'firstAppIntervalMs',
          'lastAppIntervalMs'
        ]) &&
          row.category === CATEGORIES[i] &&
          integer(row.samples) &&
          integer(row.deltaUs) &&
          nullableNumber(row.firstOffsetUs) &&
          nullableNumber(row.lastOffsetUs) &&
          intervalValid(row.firstAppIntervalMs) &&
          intervalValid(row.lastAppIntervalMs),
        'summary-invalid'
      )
    }
    requireValue(p.bins.every(countsValid), 'summary-invalid')
  }
  return value
}

async function analyzeSource(s, dir, deadline, token) {
  const bytes = (route, cap) => getBytes(route, { cap, deadline, token })
  const json = async (route) => decodeJson(await bytes(route, 64 * 1024), 64 * 1024)
  verifyRun(await json(`runs/${s.run}`), s)
  for (const a of [s.history, s.provenance]) verifyArtifact(await json(`artifacts/${a.id}`), a, s)
  for (const [id, name] of [
    [s.producerJob, 'Build mac-qa-identity'],
    [s.historyJob, 'ST-1 History row (macOS)']
  ]) {
    verifyJob(await json(`jobs/${id}`), id, name, s)
    checkoutReceipt(text(await bytes(`jobs/${id}/logs`, 16 * 1024 ** 2)), s)
  }
  const selected = []
  for (const a of [s.provenance, s.history]) {
    const archive = await bytes(`artifacts/${a.id}/zip`, a.size)
    verifyArchiveBytes(archive, a)
    const path = join(dir, `${a.id}.zip`)
    writeFileSync(path, archive, { flag: 'wx', mode: 0o600 })
    selected.push(
      await readMembers(path, a === s.history ? CAPS : { 'provenance.json': 64 * 1024 }, a, dir, deadline)
    )
  }
  const [provenance, history] = selected
  verifyProvenance(provenance['provenance.json'].value, s)
  const report = summarizeReport(history[REPORT].value, s)
  const profile = summarizeProfile(history[PROFILE].value, history[REPORT].value.cpuProfile, report)
  return {
    run: s.run,
    harnessCommit: s.commit,
    historyArtifact: s.history.id,
    provenanceArtifact: s.provenance.id,
    historyArchiveSha256: s.history.sha,
    provenanceArchiveSha256: s.provenance.sha,
    qaSha256: s.qaSha,
    binding: 'historical-provenance-report-only',
    members: {
      report: history[REPORT].sha,
      profile: history[PROFILE].sha,
      provenance: provenance['provenance.json'].sha
    },
    report,
    profile
  }
}

async function main() {
  const env = process.env
  requireValue(
    process.platform === 'linux' &&
      env.CI === 'true' &&
      env.GITHUB_ACTIONS === 'true' &&
      env.GITHUB_REPOSITORY === REPOSITORY &&
      env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      env.GITHUB_REF === 'refs/heads/main' &&
      env.GH_TOKEN &&
      isAbsolute(env.RUNNER_TEMP ?? '') &&
      process.argv.length === 2,
    'owner-state-invalid'
  )
  const deadline = performance.now() + 120_000
  const dir = mkdtempSync(join(env.RUNNER_TEMP, 'metis-retained-analysis-'))
  chmodSync(dir, 0o700)
  let cleanupAllowed = true
  let summary
  try {
    await nativeCanary(dir, deadline)
    const sources = []
    for (const s of SOURCES) sources.push(await analyzeSource(s, dir, deadline, env.GH_TOKEN))
    summary = validateSummary({
      schema: 1,
      causalConclusion: 'not-established',
      preProfileCause: 'unknown',
      instrumentation: 'startup-and-profiler-included',
      binConvention: 'sample-endpoint',
      applicationRerun: false,
      st1Evidence: false,
      promotable: false,
      sources
    })
  } catch (error) {
    cleanupAllowed = closedFailure(error) !== 'native-unacknowledged'
    throw error
  } finally {
    if (cleanupAllowed) rmSync(dir, { recursive: true })
  }
  requireValue(performance.now() < deadline, 'deadline')
  const encoded = Buffer.from(JSON.stringify(summary, null, 2) + '\n')
  requireValue(encoded.length <= 64 * 1024, 'summary-invalid')
  const output = resolve(OUTPUT)
  writeFileSync(output, encoded, { flag: 'wx', mode: 0o600 })
  const stat = lstatSync(output)
  requireValue(stat.isFile() && stat.nlink === 1 && stat.size === encoded.length, 'summary-invalid')
  const readback = readFileSync(output)
  requireValue(readback.equals(encoded), 'summary-invalid')
  validateSummary(decodeJson(readback, 64 * 1024))
  process.stdout.write('retained-profile-analysis: complete; original performance verdicts unchanged\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`retained-profile-analysis: ${closedFailure(error)}\n`)
    process.exitCode = 1
  })
}
