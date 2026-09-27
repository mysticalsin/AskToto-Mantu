#!/usr/bin/env node
/**
 * ST-1: measures whether the packaged app keeps two libuv pool threads free while the meetings root is
 * unreadable, the way the storage gateway (M2-0030/M2-0031) is meant to guarantee. Runs on the QA macOS
 * account or the managed Windows laptop — never on an owner account — against a candidate whose bytes
 * are bound to a CI run by sha256 (M2-0002).
 *
 * It measures INSIDE the packaged main process through Node's inspector (--inspect), not through any
 * product hook: an async userData write, a dns.lookup and the main event loop's own delay. Both fixture
 * kinds stand in for a cloud-only meetings-root file that blocks the thread reading it:
 *   - `fifo`: real FIFOs (POSIX only) placed as meeting and `.brain` files.
 *   - `dataless`: real evicted (dataless) files, read from `--cloud-dir`.
 *
 * Usage:
 *   node scripts/qa/st-1.mjs --installer <Metis-QA-<v>.zip | Metis-Setup-<v>.exe> --provenance <provenance.json>
 *       --fixtures fifo|dataless [--count 6] [--cloud-dir <folder of evicted files>] [--main-log <main.log>]
 *       [--exe <installed executable>] [--profile-template <userData dir>] [--minutes 5] [--out <report.json>]
 *
 * Exit codes: 0 PASS, 1 FAIL or NOT_EXERCISED, 2 usage.
 */
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { sha256File } from './provenance.mjs'
import { createFifo, releaseFifo } from './fixtures/fifo.mjs'

const MIN_FIFO_COUNT = 3
const DEFAULT_FIFO_COUNT = 6
const DEFAULT_MINUTES = 5
const LOOP_RESOLUTION_MS = 10
const INSPECTOR_WAIT_MS = 60_000
const SAMPLE_INTERVAL_MS = 1_000
const EVALUATE_TIMEOUT_MS = 1_000

/** `--cloud-dir` etc. become `args.cloudDir`, matching every camelCase read below. */
function parseArgs(argv) {
  const args = { minutes: String(DEFAULT_MINUTES) }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!flag.startsWith('--')) continue
    const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    args[key] = argv[++i]
  }
  return args
}

/** Binds the installer's bytes to the CI run that produced them (M2-0002). Throws on any mismatch. */
async function verifyCandidate(installerPath, provenancePath) {
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'))
  const name = basename(installerPath)
  const asset = provenance.builds.flatMap((build) => build.assets).find((candidate) => candidate.name === name)
  if (!asset) throw new Error(`no asset named ${name} in ${provenancePath}`)
  const actual = await sha256File(installerPath)
  if (actual !== asset.sha256) throw new Error(`sha256 mismatch for ${name}: provenance says ${asset.sha256}, file is ${actual}`)
  return { build_run_id: provenance.run.id, artifact_sha256: actual }
}

/** The installed executable to launch, and the directory (if any) to remove afterward. */
function resolveExecutable(installerPath, exeArg) {
  if (exeArg) return { exe: exeArg, unzipDir: null }
  if (process.platform === 'darwin' && installerPath.endsWith('.zip')) {
    const unzipDir = mkdtempSync(join(tmpdir(), 'st1-unzip-'))
    execFileSync('ditto', ['-x', '-k', installerPath, unzipDir])
    const apps = execFileSync('find', [unzipDir, '-maxdepth', '1', '-name', '*.app'], { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
    if (apps.length !== 1) throw usageError(`expected exactly one *.app in ${installerPath}, found ${apps.length}`)
    const app = apps[0]
    return { exe: join(app, 'Contents', 'MacOS', basename(app, '.app')), unzipDir }
  }
  throw usageError('--exe is required on this platform (Windows needs the installed Metis.exe from a verified setup)')
}

function usageError(message) {
  const error = new Error(message)
  error.usage = true
  return error
}

function prepareProfile(profileTemplate) {
  const profile = mkdtempSync(join(tmpdir(), 'metis-st1-'))
  if (profileTemplate) cpSync(profileTemplate, profile, { recursive: true })
  return profile
}

/** `count` FIFOs placed as meeting and `.brain` files under the meetings root. */
function placeFifoFixtures(root, count) {
  mkdirSync(join(root, '.brain', 'entities', 'person'), { recursive: true })
  const targets = [
    ...Array.from({ length: Math.max(0, count - 2) }, (_, i) => join(root, `2026-01-${String(i + 1).padStart(2, '0')}_090000-st1-fifo.md`)),
    join(root, '.brain', 'index.json'),
    join(root, '.brain', 'entities', 'person', 'st1-fifo.json')
  ]
  for (const target of targets) {
    rmSync(target, { force: true })
    createFifo(target)
  }
  return targets
}

/** SF_DATALESS, <sys/stat.h>: `stat -f %Uf` on macOS. */
function isDatalessMac(path) {
  const flags = Number.parseInt(execFileSync('stat', ['-f', '%Uf', path], { encoding: 'utf8' }).trim(), 10)
  return (flags & 0x4000_0000) !== 0
}

/** FILE_ATTRIBUTE_OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS, <winnt.h>. Mirrors dataless.ts's
 *  WIN_ATTRIBUTES_SCRIPT: the path travels on stdin as raw UTF-8 so the console code page can never mangle
 *  it (this profile's own root is 'Métis Meetings'), and the script itself is -EncodedCommand so no
 *  PowerShell quoting rule applies to it either. */
function isDatalessWindows(path) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$bytes = New-Object System.IO.MemoryStream',
    '[Console]::OpenStandardInput().CopyTo($bytes)',
    '$path = [Text.Encoding]::UTF8.GetString($bytes.ToArray())',
    'try { [Console]::Out.Write([string][int][IO.File]::GetAttributes($path)) } catch { [Console]::Out.Write(-1) }'
  ].join('\n')
  const attrs = Number.parseInt(
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { input: Buffer.from(path, 'utf8'), encoding: 'utf8' }
    ).trim(),
    10
  )
  return (attrs & 0x0044_1000) !== 0
}

function isDataless(path) {
  return process.platform === 'darwin' ? isDatalessMac(path) : isDatalessWindows(path)
}

/** Every file directly under `dir`, recursively. Node builtins only: `find` does not exist on Windows,
 *  and this fixture kind is the one row ST-1 also runs there (ST-1-W). */
function listFilesRecursive(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listFilesRecursive(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

/** Every dataless top-level `*.md` and `.brain/*` file in `cloudDir`, made the meetings root via a link. */
function placeDatalessFixtures(root, cloudDir) {
  rmSync(root, { recursive: true, force: true })
  symlinkSync(cloudDir, root, 'junction')
  const topLevelMarkdown = readdirSync(cloudDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(cloudDir, entry.name))
  const brainDir = join(cloudDir, '.brain')
  const brainFiles = existsSync(brainDir) ? listFilesRecursive(brainDir) : []
  const fixtures = [...topLevelMarkdown, ...brainFiles].filter(isDataless)
  if (fixtures.length === 0) throw usageError('no dataless files under --cloud-dir: evict files first')
  return fixtures
}

/** Spawns the candidate with an inspector on an OS-assigned port and returns its ws:// URL. */
async function launch(exe, profile) {
  const child = spawn(exe, ['--inspect=127.0.0.1:0'], {
    env: { ...process.env, ASKTOTO_USERDATA: profile },
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.platform !== 'win32'
  })
  let stderr = ''
  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no main-process inspector: the EnableNodeCliInspectArguments fuse may be off')), INSPECTOR_WAIT_MS)
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
      const match = /ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/.exec(stderr)
      if (match) {
        clearTimeout(timer)
        resolve(match[0])
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`candidate exited before the inspector was ready (code ${code})`))
    })
  })
  return { child, wsUrl }
}

/** A minimal Chrome DevTools Protocol client: Runtime.evaluate with a per-call answer budget. */
function cdpClient(wsUrl) {
  const socket = new WebSocket(wsUrl)
  const pending = new Map()
  let nextId = 1
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const resolver = pending.get(message.id)
    if (!resolver) return
    pending.delete(message.id)
    resolver(message.result)
  })
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('inspector socket failed to connect')))
  })
  async function evaluate(expression) {
    await ready
    const id = nextId++
    const answer = new Promise((resolve) => pending.set(id, resolve))
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    const timeout = new Promise((resolve) => setTimeout(() => resolve(undefined), EVALUATE_TIMEOUT_MS))
    const result = await Promise.race([answer, timeout])
    if (result === undefined) return { late: true }
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
    return { late: false, value: result.result?.value }
  }
  return { evaluate, close: () => socket.close() }
}

const SETUP = `(() => {
  const { monitorEventLoopDelay } = process.getBuiltinModule('node:perf_hooks')
  globalThis.__st1 = monitorEventLoopDelay({ resolution: ${LOOP_RESOLUTION_MS} })
  globalThis.__st1.enable()
  return process.env.UV_THREADPOOL_SIZE ?? 'default'
})()`

const sample = (probeFile) => `(async () => {
  const { writeFile } = process.getBuiltinModule('node:fs/promises')
  const { lookup } = process.getBuiltinModule('node:dns/promises')
  let started = performance.now()
  await writeFile(${JSON.stringify(probeFile)}, String(started))
  const writeMs = performance.now() - started
  started = performance.now()
  await lookup('localhost')
  return { writeMs, lookupMs: performance.now() - started }
})()`

const SUMMARY = '({ p99Ms: __st1.percentile(99) / 1e6, maxMs: __st1.max / 1e6 })'

async function measure(cdp, profile, minutes) {
  const poolSize = (await cdp.evaluate(SETUP)).value
  const probeFile = join(profile, 'st1-probe.txt')
  const samples = []
  let lateSamples = 0
  const deadline = Date.now() + minutes * 60_000
  while (Date.now() < deadline) {
    const result = await cdp.evaluate(sample(probeFile))
    if (result.late) lateSamples += 1
    else samples.push(result.value)
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_INTERVAL_MS))
  }
  const summary = await cdp.evaluate(SUMMARY)
  return { poolSize, samples, lateSamples, loop: summary.late ? { p99Ms: Infinity, maxMs: Infinity } : summary.value }
}

/** Whether the run actually reached the fixtures, and (dataless only) whether they stayed unread. */
function collectExercisedEvidence(kind, fixtures, mainLogPath, mainLogOffset) {
  if (kind === 'fifo') {
    const opened = fixtures.filter((fifo) => releaseFifo(fifo)).length
    return { exercised: opened >= 1 }
  }
  const stillDataless = fixtures.every(isDataless)
  const mainLogTail = mainLogPath && existsSync(mainLogPath) ? readFileSync(mainLogPath, 'utf8').slice(mainLogOffset) : ''
  return { exercised: mainLogTail.includes('[dataless] probed'), stillDataless }
}

function stopChild(child) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'])
    else process.kill(-child.pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

function cleanup({ kind, root, profile, unzipDir }) {
  if (kind === 'dataless') unlinkSync(root) // remove the junction/symlink BEFORE the recursive rmSync below
  rmSync(profile, { recursive: true, force: true })
  if (unzipDir) rmSync(unzipDir, { recursive: true, force: true })
}

function buildReport({ row, args, candidate, measured, evidence, fixtures }) {
  const criteria = [
    { name: 'inspector', pass: true },
    { name: 'no-late-samples', pass: measured.lateSamples === 0 },
    { name: 'loop-p99 < 50', pass: measured.loop.p99Ms < 50 },
    { name: 'loop-max < 250', pass: measured.loop.maxMs < 250 },
    { name: 'async-write < 250', pass: measured.samples.every((s) => s.writeMs < 250) },
    { name: 'dns-lookup < 250', pass: measured.samples.every((s) => s.lookupMs < 250) }
  ]
  if (row === 'dataless') criteria.push({ name: 'still-dataless', pass: evidence.stillDataless === true })

  const verdict = !evidence.exercised ? 'NOT_EXERCISED' : criteria.every((c) => c.pass) ? 'PASS' : 'FAIL'
  return {
    harness: 'ST-1',
    row,
    platform: process.platform,
    arch: process.arch,
    installer: basename(args.installer),
    build_run_id: candidate.build_run_id,
    artifact_sha256: candidate.artifact_sha256,
    poolSize: measured.poolSize,
    fixtures: fixtures.length,
    minutes: Number(args.minutes),
    samples: measured.samples.length,
    lateSamples: measured.lateSamples,
    loop: measured.loop,
    write: { maxMs: Math.max(0, ...measured.samples.map((s) => s.writeMs)) },
    lookup: { maxMs: Math.max(0, ...measured.samples.map((s) => s.lookupMs)) },
    exercised: evidence.exercised,
    ...(row === 'dataless' ? { stillDataless: evidence.stillDataless } : {}),
    criteria,
    verdict
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.installer || !args.provenance || !args.fixtures) {
    console.error('usage: node scripts/qa/st-1.mjs --installer <path> --provenance <path> --fixtures fifo|dataless [options]')
    return 2
  }
  if (args.fixtures === 'fifo' && process.platform === 'win32') {
    console.error('[st-1] FAIL — Windows has no FIFOs; use --fixtures dataless')
    return 2
  }
  if (args.fixtures === 'dataless' && (!args.cloudDir || !args.mainLog)) {
    console.error('[st-1] FAIL — --fixtures dataless needs --cloud-dir and --main-log')
    return 2
  }

  const candidate = await verifyCandidate(args.installer, args.provenance)
  const { exe, unzipDir } = resolveExecutable(args.installer, args.exe)
  const profile = prepareProfile(args.profileTemplate)
  const root = join(profile, 'Métis Meetings')

  const count = args.fixtures === 'fifo' ? Math.max(MIN_FIFO_COUNT, Number(args.count ?? DEFAULT_FIFO_COUNT)) : undefined
  const mainLogOffset = args.mainLog && existsSync(args.mainLog) ? statSync(args.mainLog).size : 0
  const fixtures = args.fixtures === 'fifo' ? placeFifoFixtures(root, count) : placeDatalessFixtures(root, args.cloudDir)

  const { child, wsUrl } = await launch(exe, profile)
  const cdp = cdpClient(wsUrl)
  let report
  try {
    const measured = await measure(cdp, profile, Number(args.minutes))
    const evidence = collectExercisedEvidence(args.fixtures, fixtures, args.mainLog, mainLogOffset)
    report = buildReport({ row: args.fixtures, args, candidate, measured, evidence, fixtures })
  } finally {
    cdp.close()
    stopChild(child)
    cleanup({ kind: args.fixtures, root, profile, unzipDir })
  }

  console.log(JSON.stringify(report, null, 2))
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2))
  return report.verdict === 'PASS' ? 0 : 1
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[st-1] FAIL — ${error.message}`)
    process.exit(error.usage ? 2 : 1)
  })
