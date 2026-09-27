import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LIFECYCLE_EVENTS, isOverlayUrl, parseAuditLog, smokeReport, smokeVerdict } from './packaged-smoke.mjs'

interface ProcessEntry {
  pid: number
  ppid: number
  startedMs: number
  exe: string | null
  role: string
}

interface AuditRecord {
  event: string
  [key: string]: unknown
}

interface Observation {
  installRootBusy: boolean
  launchFailed: boolean
  error: boolean
  mainPid: number | null
  readyMs: number | null
  exitedEarly: boolean
  ownedAtQuit: ProcessEntry[] | null
  quitRequested: boolean
  quitDelivered: boolean
  exit: { code: number; signal: string | null } | null
  exitMs: number | null
  audit: AuditRecord[]
  marker: boolean | null
  survivors: ProcessEntry[] | null
  survivorsGoneMs: number | null
}

describe('parseAuditLog', () => {
  it('returns records from JSON lines and skips blank and malformed lines', () => {
    const text = [
      '{"event":"app.started","seq":1}',
      '',
      'not json',
      '  ',
      '{"event":"app.renderer.ready","seq":2}'
    ].join('\n')

    expect(parseAuditLog(text)).toEqual([
      { event: 'app.started', seq: 1 },
      { event: 'app.renderer.ready', seq: 2 }
    ])
  })
})

describe('isOverlayUrl', () => {
  const overlay = 'file:///opt/smoke/Metis.app/Contents/Resources/renderer/index.html?exclusiveOnboarding=1'

  it('accepts the overlay file: document, including with a query string', () => {
    expect(isOverlayUrl(overlay)).toBe(true)
  })

  it('rejects devtools:, about:blank, and another file: page', () => {
    expect(isOverlayUrl('devtools://devtools/bundled/inspector.html')).toBe(false)
    expect(isOverlayUrl('about:blank')).toBe(false)
    expect(isOverlayUrl('file:///opt/smoke/Metis.app/Contents/Resources/renderer/settings.html')).toBe(false)
  })
})

// A fully passing observation: every stage ran and produced a clean, content-free result.
function goodObservation(): Observation {
  return {
    installRootBusy: false,
    launchFailed: false,
    error: false,
    mainPid: 100,
    readyMs: 8123,
    exitedEarly: false,
    ownedAtQuit: [
      { pid: 100, ppid: 1, startedMs: 1000, exe: '/opt/smoke/Metis.app/Contents/MacOS/Metis', role: 'Metis' },
      {
        pid: 101,
        ppid: 100,
        startedMs: 1001,
        exe: '/opt/smoke/Metis.app/Contents/Frameworks/Metis Helper (GPU).app/Contents/MacOS/Metis Helper (GPU)',
        role: 'Metis Helper (GPU)'
      }
    ],
    quitRequested: true,
    quitDelivered: true,
    exit: { code: 0, signal: null },
    exitMs: 1450,
    audit: [
      { event: 'app.started', version: '1.9.7', platform: 'darwin', arch: 'arm64' },
      { event: 'app.renderer.ready', version: '1.9.7', platform: 'darwin', arch: 'arm64' },
      { event: 'app.shutdown.clean' }
    ],
    marker: true,
    survivors: [],
    survivorsGoneMs: 300
  }
}

describe('smokeVerdict', () => {
  it('passes a complete, healthy observation', () => {
    expect(smokeVerdict(goodObservation())).toEqual({ result: 'pass', failures: [] })
  })

  const cases: Array<[string, (o: ReturnType<typeof goodObservation>) => void, string]> = [
    ['install root busy', (o) => { o.installRootBusy = true }, 'install_root_busy'],
    ['the spawn error event fired', (o) => { o.launchFailed = true }, 'launch_failed'],
    ['an unexpected exception', (o) => { o.error = true }, 'smoke_error'],
    ['an app.crash record', (o) => { o.audit = [...o.audit, { event: 'app.crash' }] }, 'app_reported_crash'],
    ['an app.unresponsive record', (o) => { o.audit = [...o.audit, { event: 'app.unresponsive' }] }, 'app_reported_crash'],
    ['main exited before the quit request', (o) => { o.exitedEarly = true }, 'exited_early'],
    ['the app was spawned but never reported ready', (o) => { o.readyMs = null }, 'renderer_not_ready'],
    [
      'the census at quit is missing main',
      (o) => { o.ownedAtQuit = [{ pid: 101, ppid: 1, startedMs: 1, exe: null, role: 'helper' }, { pid: 102, ppid: 1, startedMs: 1, exe: null, role: 'helper' }] },
      'census_vacuous'
    ],
    [
      'the census at quit holds only main',
      (o) => { o.ownedAtQuit = [{ pid: 100, ppid: 1, startedMs: 1000, exe: null, role: 'Metis' }] },
      'census_vacuous'
    ],
    ['the quit IPC could not be delivered', (o) => { o.quitDelivered = false }, 'quit_request_failed'],
    ['the app never exited after a delivered quit', (o) => { o.exit = null; o.exitMs = null }, 'quit_timeout'],
    ['exit carried a non-zero code', (o) => { o.exit = { code: 1, signal: null } }, 'exit_not_clean'],
    ['exit carried a signal', (o) => { o.exit = { code: 0, signal: 'SIGTERM' } }, 'exit_not_clean'],
    [
      'no app.shutdown.clean record was audited',
      (o) => { o.audit = o.audit.filter((r) => r.event !== 'app.shutdown.clean') },
      'shutdown_not_recorded'
    ],
    ['run-state.json did not read back clean', (o) => { o.marker = false }, 'shutdown_not_recorded'],
    [
      'a process survived the bound',
      (o) => { o.survivors = [{ pid: 999, ppid: 1, startedMs: 1, exe: null, role: 'Straggler' }] },
      'processes_survived'
    ]
  ]

  it.each(cases)('yields exactly its code: %s', (_label, mutate, code) => {
    const observation = goodObservation()
    mutate(observation)
    expect(smokeVerdict(observation)).toEqual({ result: 'fail', failures: [code] })
  })

  it('fails as smoke_incomplete when it stopped before the survivor check with no recorded cause', () => {
    const observation: Observation = {
      installRootBusy: false,
      launchFailed: false,
      error: false,
      mainPid: 100,
      readyMs: 8123,
      exitedEarly: false,
      ownedAtQuit: null,
      quitRequested: false,
      quitDelivered: false,
      exit: null,
      exitMs: null,
      audit: [{ event: 'app.started', version: '1.9.7', platform: 'darwin', arch: 'arm64' }],
      marker: null,
      survivors: null,
      survivorsGoneMs: null
    }

    expect(smokeVerdict(observation)).toEqual({ result: 'fail', failures: ['smoke_incomplete'] })
  })
})

describe('smokeReport', () => {
  it('returns exactly the schema-1 key set and leaks no path, command-line or free-text content', () => {
    const secretPath = '/Users/qa/should-not-leak/crash.log'
    const secretBootId = 'BOOT-SECRET-1234'
    const observation = {
      ...goodObservation(),
      ownedAtQuit: [
        { pid: 100, ppid: 1, startedMs: 1000, exe: `/Users/qa/secret/Metis.app/Contents/MacOS/Metis`, role: 'Metis' }
      ],
      survivors: [],
      audit: [
        {
          event: 'app.started',
          version: '1.9.7',
          platform: 'darwin',
          arch: 'arm64',
          bootId: secretBootId,
          prevBootId: 'prev-boot',
          message: secretPath
        },
        { event: 'app.renderer.ready', version: '1.9.7', platform: 'darwin', arch: 'arm64' },
        { event: 'app.shutdown.clean', bootId: secretBootId }
      ]
    }

    const report = smokeReport(observation)
    const serialized = JSON.stringify(report)

    expect(Object.keys(report)).toEqual([
      'schema',
      'result',
      'failures',
      'app',
      'events',
      'timingsMs',
      'exit',
      'shutdown',
      'processes'
    ])
    expect(Object.keys(report.app ?? {})).toEqual(['version', 'platform', 'arch'])
    expect(Object.keys(report.events)).toEqual(LIFECYCLE_EVENTS)
    expect(serialized).not.toContain(secretPath)
    expect(serialized).not.toContain(secretBootId)
    expect(serialized).not.toContain('/Users/qa/secret')
  })

  it('counts each lifecycle event and reports null timings/process maps for stages that did not run', () => {
    const observation: Observation = {
      installRootBusy: true,
      launchFailed: false,
      error: false,
      mainPid: null,
      readyMs: null,
      exitedEarly: false,
      ownedAtQuit: null,
      quitRequested: false,
      quitDelivered: false,
      exit: null,
      exitMs: null,
      audit: [],
      marker: null,
      survivors: null,
      survivorsGoneMs: null
    }

    const report = smokeReport(observation)

    expect(report.app).toBeNull()
    expect(report.events).toEqual({
      'app.started': 0,
      'app.renderer.ready': 0,
      'app.stall': 0,
      'app.crash': 0,
      'app.unresponsive': 0,
      'app.shutdown.clean': 0
    })
    expect(report.timingsMs).toEqual({ ready: null, exit: null, survivorsGone: null })
    expect(report.processes).toEqual({ atQuit: null, survivors: null })
  })
})

describe('CLI', () => {
  it('exits 2 with usage and writes no report when called with no arguments', () => {
    const scriptPath = fileURLToPath(new URL('./packaged-smoke.mjs', import.meta.url))

    const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage')
  })
})
