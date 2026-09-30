import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { WebSocketServer } from 'ws'
import { describe, expect, it } from 'vitest'
import { DRIVE_EXPRESSIONS, PAGE_PROBE, deriveRowResult } from './cdp-observe.mjs'
import { recordProblems } from '../../evidence/record.mjs'
import { m2_0008BundleProblems } from '../../evidence/check.mjs'

const SCRIPT = 'scripts/qa/freeze-repro/run-matrix.sh'
const SHA = 'a'.repeat(64)
const AUTOMATIC_ROWS = ['row-1-history-open', 'row-2-brain-status-blocked-brain', 'row-3-macos-activate', 'row-4-second-instance-reopen']
// The stub app's children, in pgrep order: three helpers before the one renderer, so first-three-children
// selection would never sample the renderer.
const CHILD_ROLES: Record<string, string> = {
  '9001': 'Metis Helper (GPU) --type=gpu-process',
  '9002': 'Metis Helper --type=utility --utility-sub-type=network.mojom.NetworkService',
  '9003': 'Metis Helper --type=utility --utility-sub-type=audio.mojom.AudioService',
  '9004': 'Metis Helper (Renderer) --type=renderer --app-path=x'
}

type Json = Record<string, any>
const bashPath = (path: string): string => path.replaceAll('\\', '/')
const writeExecutable = (path: string, body: string): void => {
  writeFileSync(path, body, 'utf8')
  chmodSync(path, 0o700)
}
const jsonl = (path: string): Json[] => readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))

/** A DevTools endpoint with one page that exposes the preload bridge. `hangHistory` never answers the
 *  row-1 recallList drive, the way a main process pinned on a FIFO read never answers. */
async function fakeDevTools({ hangHistory = false, visible = true } = {}): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const { port } = server.address() as AddressInfo
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(request.url === '/json/list'
      ? [{ type: 'service_worker' }, { type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` }]
      : []))
  })
  const sockets = new WebSocketServer({ server })
  sockets.on('connection', (socket) => {
    socket.on('message', (data) => {
      const { id, params } = JSON.parse(String(data)) as { id: number; params: { expression: string } }
      // Only the drive hangs: the page probe also names recallList (to detect the bridge) and must answer.
      if (hangHistory && params.expression === DRIVE_EXPRESSIONS.history) return
      const value = params.expression === PAGE_PROBE ? { bridge: true, visible } : true
      socket.send(JSON.stringify({ id, result: { result: { type: typeof value, value } } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => {
      for (const client of sockets.clients) client.terminate()
      sockets.close()
      server.close(() => resolve())
    })
  }
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** Runs the script with stdin closed (the pipe is ended before the script can read it). */
function runClosedStdin(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin.end()
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const timer = setTimeout(() => child.kill('SIGKILL'), 110_000)
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

/** Stub app, macOS tools and process table for a hosted-live run on any CI host. */
function hostedStubs(root: string, { sampleFails = false } = {}) {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const app = join(root, 'Metis')
  const sampleLog = join(root, 'sampled-pids.txt')
  const openLog = join(root, 'open-calls.txt')
  writeExecutable(app, '#!/usr/bin/env bash\nfor arg in "$@"; do [ "$arg" = "-e" ] && exit 0; done\nexec sleep 120\n')
  writeExecutable(join(root, 'sample'), sampleFails
    ? '#!/usr/bin/env bash\nexit 1\n'
    : `#!/usr/bin/env bash\nprintf '%s\\n' "$1" >> '${bashPath(sampleLog)}'\nprintf 'Sampling process %s for 10 seconds\\nBinary: %s/Applications/Metis.app\\n' "$1" "$HOME" > "$4"\n`)
  writeExecutable(join(root, 'open'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${bashPath(openLog)}'\n`)
  writeExecutable(join(bin, 'pgrep'), `#!/usr/bin/env bash\nprintf '%s\\n' ${Object.keys(CHILD_ROLES).join(' ')}\n`)
  writeExecutable(join(bin, 'ps'), [
    '#!/usr/bin/env bash',
    'pid=""',
    'while [ $# -gt 0 ]; do [ "$1" = "-p" ] && pid=$2; shift; done',
    'case "$pid" in',
    ...Object.entries(CHILD_ROLES).map(([pid, command]) => `  ${pid}) printf '%s\\n' '${command}' ;;`),
    '  *) exit 1 ;;',
    'esac',
    ''
  ].join('\n'))
  return { app, bin, sampleLog, openLog }
}

function hostedWindowsStubs(root: string, { secondLaunchFails = false } = {}) {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const app = join(root, 'Metis.exe')
  const launchLog = join(root, 'metis-launches.txt')
  const launchCount = join(root, 'metis-launch-count.txt')
  const forbiddenLog = join(root, 'forbidden-tools.txt')
  writeExecutable(app, [
    '#!/usr/bin/env bash',
    'for arg in "$@"; do [ "$arg" = "-e" ] && exit 0; done',
    `count=0; [ ! -f '${bashPath(launchCount)}' ] || count=$(cat '${bashPath(launchCount)}')`,
    'count=$((count + 1))',
    `printf '%s\\n' "$count" > '${bashPath(launchCount)}'`,
    `printf '%s\\n' "$*" >> '${bashPath(launchLog)}'`,
    secondLaunchFails ? '[ "$count" -ne 2 ] || exit 17' : ':',
    'exec sleep 120',
    ''
  ].join('\n'))
  for (const tool of ['pgrep', 'sample']) {
    writeExecutable(join(bin, tool), `#!/usr/bin/env bash\nprintf '%s\\n' '${tool}' >> '${bashPath(forbiddenLog)}'\nexit 42\n`)
  }
  return { app, bin, launchLog, forbiddenLog }
}

function hostedEnv(root: string, stubs: ReturnType<typeof hostedStubs>, port: number, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [stubs.bin, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
    GITHUB_RUN_ID: '456',
    M2_0008_CONTRACT_ALLOW_NON_DARWIN: '1',
    M2_0008_CONTRACT_LAUNCH_SETTLE_SECONDS: '1',
    M2_0008_CONTRACT_POLL_WAIT_SECONDS: '1',
    M2_0008_CONTRACT_REOPEN_SETTLE_SECONDS: '1',
    M2_0008_CONTRACT_SAMPLE_BIN: bashPath(join(root, 'sample')),
    M2_0008_CONTRACT_OPEN_BIN: bashPath(join(root, 'open')),
    // Named explicitly, not only through PATH: Git Bash on Windows puts its own /usr/bin (with its own ps)
    // ahead of the caller's PATH.
    M2_0008_CONTRACT_PGREP_BIN: bashPath(join(stubs.bin, 'pgrep')),
    M2_0008_CONTRACT_PS_BIN: bashPath(join(stubs.bin, 'ps')),
    M2_0008_CONTRACT_CDP_PORT: String(port),
    ...extra
  }
}

function hostedWindowsEnv(stubs: ReturnType<typeof hostedWindowsStubs>, port: number, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [stubs.bin, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
    GITHUB_RUN_ID: '789',
    M2_0008_CONTRACT_ALLOW_NON_DARWIN: '1',
    M2_0008_CONTRACT_LAUNCH_SETTLE_SECONDS: '1',
    M2_0008_CONTRACT_POLL_WAIT_SECONDS: '1',
    M2_0008_CONTRACT_REOPEN_SETTLE_SECONDS: '1',
    M2_0008_CONTRACT_CDP_PORT: String(port),
    ...extra
  }
}

const hostedArgs = (out: string, app: string): string[] =>
  ['--hosted-live', '--artifact', SHA, '--build-run-id', '123', '--app', app, '--out', out]

describe('M2-0008 freeze reproduction matrix harness', () => {
  it('dry-run creates the content-free matrix bundle and all required OS-fixture evidence files', () => {
    const out = mkdtempSync(join(tmpdir(), 'm2-0008-freeze-contract-'))
    try {
      const result = spawnSync('bash', [SCRIPT, '--artifact', SHA, '--build-run-id', '123', '--out', out, '--dry-run'], {
        encoding: 'utf8',
        timeout: 30_000
      })

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stdout).toContain(out)
      expect(readFileSync(join(out, 'environment.json'), 'utf8')).toContain('"dry_run": 1')
      expect(readFileSync(join(out, 'node-options-fuse.json'), 'utf8')).toContain('NOT_EXERCISED')
      expect(readFileSync(join(out, 'dataless-fixtures.json'), 'utf8')).toContain('"fixtures"')
      expect(readFileSync(join(out, 'external-blockers.json'), 'utf8')).toContain('"BLOCKED_EXTERNAL"')
      expect(readFileSync(join(out, 'launch-plan.json'), 'utf8')).toContain('"electron_user_data_dir_switch":true')
      expect(readFileSync(join(out, 'diagnostic-reports.json'), 'utf8')).toContain('"consented":false')
      expect(readFileSync(join(out, 'diagnostic-reports.json'), 'utf8')).toContain('Metis/AskToto process names or sampled process ids only')
      expect(readFileSync(join(out, 'M2-0008.lead-action.md'), 'utf8')).toContain('LEAD_ACTION:')
      expect(readFileSync(join(out, 'M2-0008.lead-action.md'), 'utf8')).toContain('OBSERVED')
      expect(readFileSync(join(out, 'M2-0008.lead-action.md'), 'utf8')).toContain('DERIVED')

      const fixtures = JSON.parse(readFileSync(join(out, 'fifo-fixtures.json'), 'utf8')) as {
        kind: string
        count: number
        fixtures: { path: string; opened_by_1_9_6: boolean | null }[]
      }
      expect(fixtures.kind).toBe('fifo')
      expect(fixtures.count).toBeGreaterThanOrEqual(6)
      expect(fixtures.fixtures.some((fixture) => fixture.path.endsWith('.brain/index.json'))).toBe(true)
      expect(fixtures.fixtures.filter((fixture) => fixture.path.endsWith('.md'))).toHaveLength(4)
      expect(fixtures.fixtures.every((fixture) => Object.hasOwn(fixture, 'opened_by_1_9_6'))).toBe(true)

      const matrix = readFileSync(join(out, 'matrix.jsonl'), 'utf8')
      expect(matrix).toContain('row-1-history-open')
      expect(matrix).toContain('row-2-brain-status-blocked-brain')
      expect(matrix).toContain('row-3-macos-activate')
      expect(matrix).toContain('row-4-second-instance-reopen')
      expect(matrix).toContain('row-5-dataless-brain-idle')
      expect(matrix).toContain('row-9-network-off-flapping')
      expect(matrix).toContain('"fixture":"dataless-brain-index"')
      expect(matrix).toContain('"fixture":"dataless-meeting"')

      const interrupts = readFileSync(join(out, 'interrupt-results.jsonl'), 'utf8')
      expect(interrupts).toContain('network-off')
      expect(interrupts).toContain('file-provider-cancel')
      expect(interrupts).toContain('process-signal')
      expect(readFileSync(join(out, 'M2-0008.records.README.md'), 'utf8')).toContain('dry run')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('refuses a live run unless the operator asserts the QA account boundary', () => {
    const out = mkdtempSync(join(tmpdir(), 'm2-0008-freeze-contract-'))
    try {
      const result = spawnSync('bash', [SCRIPT, '--artifact', SHA, '--build-run-id', '123', '--out', out], {
        encoding: 'utf8',
        timeout: 30_000
      })
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('--qa-account is required')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('refuses a live run without mandatory dataless fixtures', () => {
    const out = mkdtempSync(join(tmpdir(), 'm2-0008-freeze-contract-'))
    const profile = mkdtempSync(join(tmpdir(), 'm2-0008-profile-'))
    const app = join(out, 'Metis')
    try {
      writeFileSync(app, '#!/usr/bin/env bash\nexit 0\n', 'utf8')
      chmodSync(app, 0o700)
      const result = spawnSync('bash', [
        SCRIPT,
        '--artifact', SHA,
        '--build-run-id', '123',
        '--out', out,
        '--app', app,
        '--profile-template', profile,
        '--implementer-session-id', 'impl-1',
        '--validator-session-id', 'valid-1',
        '--qa-account'
      ], {
        encoding: 'utf8',
        env: { ...process.env, M2_0008_CONTRACT_ALLOW_NON_DARWIN: '1' },
        timeout: 30_000
      })
      expect(result.status).toBe(2)
      expect(result.stderr).toContain('--dataless-brain-index is required')
    } finally {
      rmSync(out, { recursive: true, force: true })
      rmSync(profile, { recursive: true, force: true })
    }
  })

  it('refuses PASS evidence when a live run cannot collect both main and renderer samples', () => {
    const out = mkdtempSync(join(tmpdir(), 'm2-0008-freeze-contract-'))
    const profile = mkdtempSync(join(tmpdir(), 'm2-0008-profile-'))
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'm2-0008-fixtures-'))
    const pathRoot = mkdtempSync(join(tmpdir(), 'm2-0008-path-'))
    const app = join(out, 'Metis')
    const fakeStat = join(pathRoot, 'stat')
    const brainIndex = join(fixtureRoot, 'index.json')
    const meeting = join(fixtureRoot, 'meeting.md')
    try {
      writeFileSync(app, '#!/usr/bin/env bash\nfor arg in "$@"; do [ "$arg" = "-e" ] && exit 0; done\nsleep 120\n', 'utf8')
      chmodSync(app, 0o700)
      writeFileSync(brainIndex, '{}\n', 'utf8')
      writeFileSync(meeting, '# synthetic\n', 'utf8')
      writeFileSync(fakeStat, '#!/usr/bin/env bash\nprintf "1073741824\\n"\n', 'utf8')
      chmodSync(fakeStat, 0o700)

      const result = spawnSync('bash', [
        SCRIPT,
        '--artifact', SHA,
        '--build-run-id', '123',
        '--out', out,
        '--app', app,
        '--profile-template', profile,
        '--dataless-brain-index', brainIndex,
        '--dataless-meeting', meeting,
        '--implementer-session-id', 'impl-1',
        '--validator-session-id', 'valid-1',
        '--qa-account'
      ], {
        encoding: 'utf8',
        input: '\n\n\n\n\n\n\n\n\n',
        env: {
          ...process.env,
          PATH: `${pathRoot}:${process.env.PATH ?? ''}`,
          M2_0008_CONTRACT_ALLOW_NON_DARWIN: '1',
          M2_0008_CONTRACT_IDLE_SECONDS: '1',
          M2_0008_CONTRACT_LAUNCH_SETTLE_SECONDS: '1'
        },
        timeout: 45_000
      })

      expect(result.status).toBe(2)
      expect(result.stderr).toContain('required main and renderer samples')
      const manifest = readFileSync(join(out, 'M2-0008.evidence-import.json'), 'utf8')
      expect(manifest).toContain('"result": "FAIL"')
      expect(manifest).not.toContain('"result": "PASS"')
      expect(manifest).toContain('"required_evidence_level": "LIVE_VERIFIED"')
      expect(readFileSync(join(out, 'owner-bug-records.json'), 'utf8')).toContain('"history-freeze"')
      expect(readFileSync(join(out, 'owner-bug-records.json'), 'utf8')).toContain('"no-reopen"')
      expect(readFileSync(join(out, 'diagnostic-reports.json'), 'utf8')).toContain('"consented":false')

      const matrix = readFileSync(join(out, 'matrix.jsonl'), 'utf8')
      expect(matrix).toContain('"fixture":"dataless-brain-index"')
      expect(matrix).toContain('"fixture":"dataless-meeting"')
      expect(matrix).not.toContain(brainIndex)
      expect(matrix).not.toContain(meeting)
    } finally {
      rmSync(out, { recursive: true, force: true })
      rmSync(profile, { recursive: true, force: true })
      rmSync(fixtureRoot, { recursive: true, force: true })
      rmSync(pathRoot, { recursive: true, force: true })
    }
  })

  it('refuses PASS evidence when required live rows and interrupt checks are not exercised', () => {
    const out = mkdtempSync(join(tmpdir(), 'm2-0008-freeze-contract-'))
    const profile = mkdtempSync(join(tmpdir(), 'm2-0008-profile-'))
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'm2-0008-fixtures-'))
    const pathRoot = mkdtempSync(join(tmpdir(), 'm2-0008-path-'))
    const app = join(out, 'Metis')
    const fakeStat = join(pathRoot, 'stat')
    const brainIndex = join(fixtureRoot, 'index.json')
    const meeting = join(fixtureRoot, 'meeting.md')
    try {
      writeFileSync(app, '#!/usr/bin/env bash\nfor arg in "$@"; do [ "$arg" = "-e" ] && exit 0; done\nsleep 120\n', 'utf8')
      chmodSync(app, 0o700)
      writeFileSync(brainIndex, '{}\n', 'utf8')
      writeFileSync(meeting, '# synthetic\n', 'utf8')
      writeFileSync(fakeStat, '#!/usr/bin/env bash\nprintf "1073741824\\n"\n', 'utf8')
      chmodSync(fakeStat, 0o700)

      const result = spawnSync('bash', [
        SCRIPT,
        '--artifact', SHA,
        '--build-run-id', '123',
        '--out', out,
        '--app', app,
        '--profile-template', profile,
        '--dataless-brain-index', brainIndex,
        '--dataless-meeting', meeting,
        '--implementer-session-id', 'impl-1',
        '--validator-session-id', 'valid-1',
        '--qa-account'
      ], {
        encoding: 'utf8',
        input: '\n\n\n\n\n\n\n\n\n',
        env: {
          ...process.env,
          PATH: `${pathRoot}:${process.env.PATH ?? ''}`,
          M2_0008_CONTRACT_ALLOW_NON_DARWIN: '1',
          M2_0008_CONTRACT_IDLE_SECONDS: '1',
          M2_0008_CONTRACT_LAUNCH_SETTLE_SECONDS: '1'
        },
        timeout: 45_000
      })

      expect(result.status).toBe(2)
      expect(result.stderr).toContain('required matrix rows exercised')
      expect(result.stderr).toContain('required interrupt checks exercised')
      const manifest = readFileSync(join(out, 'M2-0008.evidence-import.json'), 'utf8')
      expect(manifest).toContain('"result": "FAIL"')
      expect(manifest).toContain('"matrix_result_failures": 6')
      expect(manifest).toContain('"interrupt_result_failures": 3')
      expect(manifest).toContain('"first": "M2-0008"')
      expect(manifest).toContain('"second": "M2-0009"')
    } finally {
      rmSync(out, { recursive: true, force: true })
      rmSync(profile, { recursive: true, force: true })
      rmSync(fixtureRoot, { recursive: true, force: true })
      rmSync(pathRoot, { recursive: true, force: true })
    }
  })

  it('collects DiagnosticReports only with explicit consent and process-scoped matching', () => {
    const out = mkdtempSync(join(tmpdir(), 'm2-0008-freeze-contract-'))
    try {
      const result = spawnSync('bash', [SCRIPT, '--artifact', SHA, '--build-run-id', '123', '--out', out, '--dry-run', '--collect-diagnostic-reports'], {
        encoding: 'utf8',
        timeout: 30_000
      })

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      const diagnosticReports = readFileSync(join(out, 'diagnostic-reports.json'), 'utf8')
      expect(diagnosticReports).toContain('"consented":true')
      expect(diagnosticReports).toContain('Metis/AskToto process names or sampled process ids only')
      expect(diagnosticReports).toContain('"copied":[')
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })
})

describe('M2-0462 hosted-live mode', () => {
  it('drives rows 1-4 itself with stdin closed, samples main and the role-selected renderer, and emits a valid hosted-runner bundle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'm2-0462-hosted-'))
    const out = join(root, 'bundle')
    const devtools = await fakeDevTools()
    try {
      const stubs = hostedStubs(root)
      const result = await runClosedStdin(hostedArgs(out, stubs.app), hostedEnv(root, stubs, devtools.port))

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.stderr).not.toContain('result for')
      expect(result.stderr).not.toContain('press return')

      const matrix = jsonl(join(out, 'matrix.jsonl'))
      for (const row of AUTOMATIC_ROWS) {
        const recorded = matrix.find((entry) => entry.row === row && 'operator_result' in entry)
        expect(recorded, row).toMatchObject({ automatic: true, operator_result: 'pass', precondition: 'ok' })
        expect(recorded?.drive_method, row).toEqual(expect.any(String))
        expect(recorded?.observation, row).toMatchObject({
          operator_result: 'pass',
          symptom_observed: false,
          cdp: { reachable: true, renderer_round_trip: 'answered', main_answered: true, window_visible: true, window_visible_observed_by: 'cdp:document.visibilityState' }
        })
        const sample = matrix.find((entry) => entry.row === row && 'sampled' in entry)
        expect(sample, row).toMatchObject({ sampled: true, main_sample: true, renderer_attempts: 1, renderer_samples: 1, renderers_selected_by: '--type=renderer' })
        expect(existsSync(join(out, 'samples', `${row}-renderer-9004.sample.txt`)), row).toBe(true)
      }
      expect(matrix.find((entry) => entry.row === 'row-1-history-open' && 'observation' in entry)?.observation.cdp.drive).toBe('answered')
      expect(matrix.find((entry) => entry.row === 'row-2-brain-status-blocked-brain' && 'observation' in entry)?.brain_status_poll_wait_seconds).toBe(1)
      for (const row of ['row-5-dataless-brain-idle', 'row-9-network-off-flapping']) {
        expect(matrix.find((entry) => entry.row === row), row).toMatchObject({ status: 'BLOCKED_EXTERNAL', automatic: false, unblock_step: expect.stringContaining('test cloud-file account') })
      }

      const sampled = readFileSync(stubs.sampleLog, 'utf8').split(/\r?\n/).filter(Boolean)
      expect(sampled).toContain('9004')
      expect(sampled.filter((pid) => ['9001', '9002', '9003'].includes(pid))).toEqual([])
      expect(sampled.filter((pid) => pid !== '9004')).toHaveLength(AUTOMATIC_ROWS.length)
      for (const file of readdirSync(join(out, 'samples'))) {
        const text = readFileSync(join(out, 'samples', file), 'utf8')
        expect(text).toContain('$HOME/Applications/Metis.app')
        expect(file).not.toContain('.raw.')
      }

      const opens = readFileSync(stubs.openLog, 'utf8').split(/\r?\n/).filter(Boolean)
      expect(opens).toHaveLength(2)
      expect(opens[0].startsWith('-n ')).toBe(false)
      expect(opens[1]).toMatch(/^-n --env ASKTOTO_USERDATA=.+ --args --user-data-dir=.+/)

      const interrupts = jsonl(join(out, 'interrupt-results.jsonl'))
      expect(interrupts.map((entry) => entry.interrupt).sort()).toEqual(['file-provider-cancel', 'network-off', 'process-signal'])
      expect(interrupts.find((entry) => entry.interrupt === 'process-signal')).toMatchObject({ automatic: true, result: 'pass', signal: 'TERM', exited_within_10s: true })
      for (const interrupt of ['network-off', 'file-provider-cancel']) {
        expect(interrupts.find((entry) => entry.interrupt === interrupt), interrupt).toMatchObject({ status: 'BLOCKED_EXTERNAL', unblock_step: expect.stringContaining('D-9') })
      }

      const environment = JSON.parse(readFileSync(join(out, 'environment.json'), 'utf8'))
      expect(environment).toMatchObject({ mode: 'hosted-live', dry_run: 0, profile_template_used: 'no', host: { label: 'macos-latest' } })
      expect(environment.host.os_version).toEqual(expect.any(String))
      expect(environment.host.arch).toEqual(expect.any(String))
      expect(JSON.parse(readFileSync(join(out, 'node-options-fuse.json'), 'utf8')).node_options_fuse).not.toBe('NOT_EXERCISED')
      const fifo = JSON.parse(readFileSync(join(out, 'fifo-fixtures.json'), 'utf8'))
      expect(fifo.count).toBeGreaterThanOrEqual(6)
      expect(fifo.fixtures.some((fixture: Json) => fixture.path === 'Métis Meetings/.brain/index.json')).toBe(true)
      expect(fifo.fixtures.every((fixture: Json) => typeof fixture.opened_by_1_9_6 === 'boolean')).toBe(true)
      const blockers = JSON.parse(readFileSync(join(out, 'external-blockers.json'), 'utf8'))
      expect(blockers.blockers[0]).toMatchObject({ status: 'BLOCKED_EXTERNAL', rows: ['row-5-dataless-brain-idle', 'row-9-network-off-flapping'], interrupts: ['network-off', 'file-provider-cancel'] })

      const summary = JSON.parse(readFileSync(join(out, 'hosted-live-summary.json'), 'utf8'))
      expect(summary).toMatchObject({ mode: 'hosted-live', reproduced: false, symptom_rows: [] })
      expect(summary.conclusion).toMatch(/^documented-unsuccessful:/)
      expect(readFileSync(join(out, 'README.md'), 'utf8')).toContain('documented-unsuccessful')

      const evidenceImport = JSON.parse(readFileSync(join(out, 'M2-0008.evidence-import.json'), 'utf8'))
      expect(evidenceImport).toMatchObject({
        mode: 'hosted-live',
        result: 'PASS',
        exit_code: 0,
        artifact_sha256: SHA,
        build_run_id: 123,
        ci_run_id: 456,
        environment: { kind: 'hosted-runner', host: 'macos-latest' },
        matrix_result_failures: 0,
        interrupt_result_failures: 0,
        sample_failures: 0,
        reproduced: false
      })
      expect(evidenceImport).not.toHaveProperty('qa_host_label')
      expect(JSON.stringify(evidenceImport)).not.toContain('qa-mac-1')
      const liveRecord = {
        schema: 1,
        ticket: 'M2-0008',
        evidence_level: 'LIVE_VERIFIED',
        recorded_at: evidenceImport.recorded_at,
        kit_refs: {},
        finding_refs: [],
        commit: 'b'.repeat(40),
        result: evidenceImport.result,
        implementer_session: { model: 'claude-sonnet-5', id: 'impl-1' },
        validator_session: { model: 'claude-opus-5', id: 'valid-1' },
        environment: evidenceImport.environment,
        ci_run_id: evidenceImport.ci_run_id,
        artifact_sha256: evidenceImport.artifact_sha256,
        build_run_id: evidenceImport.build_run_id,
        command: evidenceImport.command,
        exit_code: evidenceImport.exit_code,
        output: { path: 'evidence/outputs/M2-0008/matrix.jsonl', sha256: evidenceImport.matrix_sha256 }
      }
      expect(recordProblems(liveRecord)).toEqual([])
      expect(recordProblems({ ...liveRecord, environment: { kind: 'hosted-runner', host: 'qa-mac-1' } }).join('\n')).toContain('environment.host')

      expect(m2_0008BundleProblems(out)).toEqual([])
    } finally {
      await devtools.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('records an observed freeze from a round trip that never answers and still produces PASS evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'm2-0462-hosted-'))
    const out = join(root, 'bundle')
    const devtools = await fakeDevTools({ hangHistory: true })
    try {
      const stubs = hostedStubs(root)
      const result = await runClosedStdin(hostedArgs(out, stubs.app),
        hostedEnv(root, stubs, devtools.port, { M2_0008_CONTRACT_OBSERVE_TIMEOUT_MS: '5000' }))

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      const row1 = jsonl(join(out, 'matrix.jsonl')).find((entry) => entry.row === 'row-1-history-open' && 'operator_result' in entry)
      expect(row1).toMatchObject({ operator_result: 'observed', observation: { symptom_observed: true, reason: 'round-trip-timeout', cdp: { drive: 'timeout' } } })
      const summary = JSON.parse(readFileSync(join(out, 'hosted-live-summary.json'), 'utf8'))
      expect(summary).toMatchObject({ reproduced: true, symptom_rows: ['row-1-history-open'] })
      expect(summary.conclusion).toMatch(/^reproduced:/)
      expect(m2_0008BundleProblems(out)).toEqual([])
    } finally {
      await devtools.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('counts an automatic row that could not be observed as a failure, but never a BLOCKED_EXTERNAL row', async () => {
    const root = mkdtempSync(join(tmpdir(), 'm2-0462-hosted-'))
    const out = join(root, 'bundle')
    try {
      const stubs = hostedStubs(root)
      const result = await runClosedStdin(hostedArgs(out, stubs.app), hostedEnv(root, stubs, await unusedPort()))

      expect(result.status).toBe(2)
      expect(result.stderr).toContain('required matrix rows exercised')
      expect(result.stderr).not.toContain('result for')
      const matrix = jsonl(join(out, 'matrix.jsonl'))
      for (const row of AUTOMATIC_ROWS) {
        expect(matrix.find((entry) => entry.row === row && 'operator_result' in entry), row)
          .toMatchObject({ operator_result: 'not-exercised', observation: { reason: 'devtools-unreachable' } })
      }
      const evidenceImport = JSON.parse(readFileSync(join(out, 'M2-0008.evidence-import.json'), 'utf8'))
      expect(evidenceImport).toMatchObject({ result: 'FAIL', matrix_result_failures: AUTOMATIC_ROWS.length, interrupt_result_failures: 0 })
      expect(JSON.parse(readFileSync(join(out, 'hosted-live-summary.json'), 'utf8')).conclusion).toMatch(/^incomplete:/)
      expect(m2_0008BundleProblems(out).join('\n')).toContain('must be an automatic row that was exercised')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('counts a missing main or renderer sample as a failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'm2-0462-hosted-'))
    const out = join(root, 'bundle')
    const devtools = await fakeDevTools()
    try {
      const stubs = hostedStubs(root, { sampleFails: true })
      const result = await runClosedStdin(hostedArgs(out, stubs.app), hostedEnv(root, stubs, devtools.port))

      expect(result.status).toBe(2)
      expect(result.stderr).toContain('required main and renderer samples')
      expect(JSON.parse(readFileSync(join(out, 'M2-0008.evidence-import.json'), 'utf8'))).toMatchObject({ result: 'FAIL', exit_code: 2 })
      expect(m2_0008BundleProblems(out).join('\n')).toContain('must have main and role-selected renderer samples')
    } finally {
      await devtools.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('is mutually exclusive with --dry-run and refuses a real profile template or cloud-file fixtures', () => {
    const root = mkdtempSync(join(tmpdir(), 'm2-0462-hosted-'))
    const out = join(root, 'bundle')
    try {
      const env = { ...process.env, M2_0008_CONTRACT_ALLOW_NON_DARWIN: '1' }
      const both = spawnSync('bash', [SCRIPT, '--hosted-live', '--dry-run', '--artifact', SHA, '--build-run-id', '123', '--app', root, '--out', out], { encoding: 'utf8', env, timeout: 30_000 })
      expect(both.status).toBe(2)
      expect(both.stderr).toContain('--hosted-live and --dry-run are mutually exclusive')

      const template = spawnSync('bash', [SCRIPT, ...hostedArgs(out, root), '--profile-template', root], { encoding: 'utf8', env, timeout: 30_000 })
      expect(template.status).toBe(2)
      expect(template.stderr).toContain('--profile-template is not accepted')

      const dataless = spawnSync('bash', [SCRIPT, ...hostedArgs(out, root), '--dataless-brain-index', root], { encoding: 'utf8', env, timeout: 30_000 })
      expect(dataless.status).toBe(2)
      expect(dataless.stderr).toContain('rows 5 and 9 are BLOCKED_EXTERNAL')

      const host = spawnSync('bash', [SCRIPT, ...hostedArgs(out, root), '--qa-host-label', 'qa-mac-1'], { encoding: 'utf8', env, timeout: 30_000 })
      expect(host.status).toBe(2)
      expect(host.stderr).toContain('macos-latest or windows-latest')

      const noApp = spawnSync('bash', [SCRIPT, '--hosted-live', '--artifact', SHA, '--build-run-id', '123', '--out', out], { encoding: 'utf8', env, timeout: 30_000 })
      expect(noApp.status).toBe(2)
      expect(noApp.stderr).toContain('--app is required')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('M2-0463 Windows hosted-live mode', () => {
  it('launches Metis.exe with a synthetic profile, drives row 1 and row 4, and never uses pgrep or sample', async () => {
    const root = mkdtempSync(join(tmpdir(), 'm2-0463-windows-hosted-'))
    const out = join(root, 'bundle')
    const devtools = await fakeDevTools()
    try {
      const stubs = hostedWindowsStubs(root)
      const result = await runClosedStdin(
        [...hostedArgs(out, stubs.app), '--qa-host-label', 'windows-latest'],
        hostedWindowsEnv(stubs, devtools.port)
      )

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
      expect(existsSync(stubs.forbiddenLog)).toBe(false)

      const launches = readFileSync(stubs.launchLog, 'utf8').split(/\r?\n/).filter(Boolean)
      expect(launches).toHaveLength(2)
      expect(launches.every((line) => line.includes('--user-data-dir='))).toBe(true)
      expect(launches.every((line) => line.includes('--remote-debugging-port='))).toBe(true)

      const matrix = jsonl(join(out, 'matrix.jsonl'))
      expect(matrix.find((entry) => entry.row === 'row-1-history-open' && 'operator_result' in entry))
        .toMatchObject({ automatic: true, operator_result: 'pass', drive_method: expect.stringContaining('window.toto.recallList()') })
      expect(matrix.find((entry) => entry.row === 'row-4-second-instance-reopen' && 'operator_result' in entry))
        .toMatchObject({ automatic: true, operator_result: 'pass', drive_method: expect.stringContaining('re-launch Metis.exe') })
      expect(matrix.find((entry) => entry.row === 'row-3-macos-activate'))
        .toMatchObject({ operator_result: 'not-applicable', reason: expect.stringContaining('macOS-only') })
      expect(matrix.find((entry) => entry.row === 'row-2-brain-status-blocked-brain'))
        .toMatchObject({ status: 'BLOCKED_EXTERNAL', unblock_step: expect.stringContaining('FIFO') })
      for (const row of ['row-5-dataless-brain-idle', 'row-9-network-off-flapping']) {
        expect(matrix.find((entry) => entry.row === row), row).toMatchObject({ status: 'BLOCKED_EXTERNAL' })
      }
      for (const row of ['row-1-history-open', 'row-4-second-instance-reopen']) {
        expect(matrix.find((entry) => entry.row === row && 'sampled' in entry), row)
          .toMatchObject({ sampled: false, reason: expect.stringContaining('sampling unavailable') })
      }

      const summary = JSON.parse(readFileSync(join(out, 'hosted-live-summary.json'), 'utf8'))
      expect(summary).toMatchObject({
        mode: 'hosted-live',
        automatic_rows: ['row-1-history-open', 'row-4-second-instance-reopen'],
        not_applicable_rows: ['row-3-macos-activate'],
        reproduced: false
      })
      expect(summary.blocked_external_rows).toContain('row-2-brain-status-blocked-brain')

      const environment = JSON.parse(readFileSync(join(out, 'environment.json'), 'utf8'))
      expect(environment).toMatchObject({ mode: 'hosted-live', host: { label: 'windows-latest' } })
      const evidenceImport = JSON.parse(readFileSync(join(out, 'M2-0008.evidence-import.json'), 'utf8'))
      expect(evidenceImport).toMatchObject({
        mode: 'hosted-live',
        result: 'PASS',
        environment: { kind: 'hosted-runner', host: 'windows-latest' },
        ci_run_id: 789,
        sample_failures: 0,
        matrix_result_failures: 0
      })
      expect(evidenceImport.blocked_external_rows).toContain('row-2-brain-status-blocked-brain')
      expect(m2_0008BundleProblems(out)).toEqual([])
    } finally {
      await devtools.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)

  it('records row 4 as not-exercised when the second Metis.exe launch exits non-zero', async () => {
    const root = mkdtempSync(join(tmpdir(), 'm2-0463-windows-hosted-'))
    const out = join(root, 'bundle')
    const devtools = await fakeDevTools()
    try {
      const stubs = hostedWindowsStubs(root, { secondLaunchFails: true })
      const result = await runClosedStdin(
        [...hostedArgs(out, stubs.app), '--qa-host-label', 'windows-latest'],
        hostedWindowsEnv(stubs, devtools.port)
      )

      expect(result.status).toBe(2)
      expect(existsSync(stubs.forbiddenLog)).toBe(false)

      const matrix = jsonl(join(out, 'matrix.jsonl'))
      expect(matrix.find((entry) => entry.row === 'row-4-second-instance-reopen' && 'operator_result' in entry))
        .toMatchObject({ automatic: true, operator_result: 'not-exercised', precondition: 'relaunch-failed' })

      const evidenceImport = JSON.parse(readFileSync(join(out, 'M2-0008.evidence-import.json'), 'utf8'))
      expect(evidenceImport).toMatchObject({
        mode: 'hosted-live',
        result: 'FAIL',
        matrix_result_failures: 1
      })
    } finally {
      await devtools.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 120_000)
})

describe('M2-0462 cdp-observe derivation', () => {
  const answered = {
    reachable: true,
    page_targets: 1,
    renderer_round_trip: 'answered',
    main_round_trip: 'answered',
    main_answered: true,
    drive: 'none',
    window_visible: true
  }

  it('derives pass, observed and not-exercised from observations only', () => {
    expect(deriveRowResult('row-1-history-open', { ...answered, drive: 'answered' })).toMatchObject({ operator_result: 'pass', symptom_observed: false })
    expect(deriveRowResult('row-1-history-open', { ...answered, drive: 'timeout' })).toMatchObject({ operator_result: 'observed', symptom_observed: true })
    expect(deriveRowResult('row-2-brain-status-blocked-brain', { ...answered, main_round_trip: 'timeout', main_answered: false })).toMatchObject({ operator_result: 'observed' })
    expect(deriveRowResult('row-3-macos-activate', { ...answered, window_visible: false })).toMatchObject({ operator_result: 'observed', reason: 'no-visible-window' })
    expect(deriveRowResult('row-1-history-open', { ...answered, window_visible: false })).toMatchObject({ operator_result: 'pass' })
    expect(deriveRowResult('row-4-second-instance-reopen', { ...answered, reachable: false, page_targets: 0 })).toMatchObject({ operator_result: 'not-exercised' })
    expect(deriveRowResult('row-1-history-open', { ...answered, main_round_trip: 'no-bridge', drive: 'no-bridge' })).toMatchObject({ operator_result: 'not-exercised' })
  })
})
