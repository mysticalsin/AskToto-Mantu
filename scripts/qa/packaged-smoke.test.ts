import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  hoverWatchRestRect,
  parkAfterExclusiveOnboarding,
  rightEdgeSidecarBounds,
  type DisplayMetrics
} from '../../src/main/island/geometry'
import {
  LIFECYCLE_EVENTS,
  auditDiagnostic,
  bootLaunchActivateVerdict,
  buildWindowsShortcutLauncher,
  NAVIGATION_GUARD_BOOTSTRAP_PATCH,
  childPidReserved,
  computeCleanupTargets,
  isOverlayUrl,
  isPassingRevealEvidence,
  waitUntilParked,
  parseAuditLog,
  readObservationTail,
  initialRvRows,
  initialNavigationGuardRows,
  initialRightEdgeHideRows,
  navigationMeetingTitles,
  rightEdgeExpectedRects,
  rightEdgeHideParkMatches,
  rightEdgeStateMatches,
  rightEdgeStateMismatches,
  runRevealRow,
  seedOnboardedProfile,
  smokeReport,
  smokeVerdict
} from './packaged-smoke.mjs'

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
  rv: Array<{
    id: string
    reason: string
    automation: string
    status: string
    evidence: { event: string; reason: string; outcome: string | null; parked?: boolean; layout?: string | null } | null
    unblock: string | null
  }>
  navigationGuard: Array<{
    id: string
    state: string
    entry: string
    status: string
    evidence: Record<string, unknown> | null
    unblock: string | null
  }>
  rightEdgeHide?: Array<{
    id: string
    layout: string
    status: string
    evidence: Record<string, unknown> | null
    unblock: string | null
  }>
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
    rv: [
      {
        id: 'RV-1-macos-open-activate',
        reason: 'activate',
        automation: 'open-app-path',
        status: 'PASS',
        evidence: { event: 'reveal', reason: 'activate', outcome: 'shown', parked: true, layout: 'hide' },
        unblock: null
      },
      {
        id: 'RV-2-macos-open-new-instance',
        reason: 'second-instance',
        automation: 'open-new-instance',
        status: 'PASS',
        evidence: { event: 'reveal', reason: 'second-instance', outcome: 'shown', parked: true, layout: 'hide' },
        unblock: null
      },
      {
        id: 'RV-4-tray-show',
        reason: 'tray',
        automation: 'tray-menu',
        status: 'PASS',
        evidence: { event: 'reveal', reason: 'tray', outcome: 'shown', parked: true, layout: 'hide' },
        unblock: null
      },
      {
        id: 'RV-4-global-hotkey',
        reason: 'hotkey',
        automation: 'global-hotkey',
        status: 'PASS',
        evidence: { event: 'reveal', reason: 'hotkey', outcome: 'shown', parked: true, layout: 'hide' },
        unblock: null
      },
      {
        id: 'RV-1-macos-finder-spotlight-launchpad',
        reason: 'activate',
        automation: 'finder-open-app-file',
        status: 'PASS',
        evidence: { event: 'reveal', reason: 'activate', outcome: 'shown', parked: true, layout: 'hide' },
        unblock: null
      }
    ],
    navigationGuard: initialNavigationGuardRows().map((row) => ({
      ...row,
      status: 'PASS',
      evidence: { observed: true }
    })),
    rightEdgeHide: initialRightEdgeHideRows().map((row) => ({
      ...row,
      status: 'PASS',
      evidence: { observed: true }
    })),
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
    ],
    [
      'an automated RV row failed',
      (o) => { o.rv[0] = { ...o.rv[0], status: 'FAIL', evidence: null } },
      'rv_reopen_failed'
    ],
    [
      'an automated RV row never completed after renderer readiness',
      (o) => { o.rv[0] = { ...o.rv[0], status: 'PENDING', evidence: null } },
      'rv_reopen_incomplete'
    ],
    [
      'an automated navigation guard row failed',
      (o) => { o.navigationGuard[0] = { ...o.navigationGuard[0], status: 'FAIL', evidence: null } },
      'navigation_guard_failed'
    ],
    [
      'an automated navigation guard row never completed after renderer readiness',
      (o) => { o.navigationGuard[0] = { ...o.navigationGuard[0], status: 'PENDING', evidence: null } },
      'navigation_guard_incomplete'
    ],
    [
      'an automated right-edge Hide row failed',
      (o) => { o.rightEdgeHide![0] = { ...o.rightEdgeHide![0], status: 'FAIL', evidence: null } },
      'right_edge_hide_failed'
    ],
    [
      'an automated right-edge Hide row never completed after renderer readiness',
      (o) => { o.rightEdgeHide![0] = { ...o.rightEdgeHide![0], status: 'PENDING', evidence: null } },
      'right_edge_hide_incomplete'
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
      rv: goodObservation().rv,
      navigationGuard: goodObservation().navigationGuard,
      survivors: null,
      survivorsGoneMs: null
    }

    expect(smokeVerdict(observation)).toEqual({ result: 'fail', failures: ['smoke_incomplete'] })
  })

  it('does not fail a completed smoke observation for BLOCKED_EXTERNAL rows', () => {
    const observation = goodObservation()
    observation.rv[0] = {
      ...observation.rv[0],
      status: 'BLOCKED_EXTERNAL',
      evidence: null,
      unblock: 'Run this row where the outside dependency is available.'
    }
    observation.navigationGuard[0] = {
      ...observation.navigationGuard[0],
      status: 'BLOCKED_EXTERNAL',
      evidence: null,
      unblock: 'Run this row where the outside dependency is available.'
    }

    expect(smokeVerdict(observation)).toEqual({ result: 'pass', failures: [] })
  })
})

describe('isPassingRevealEvidence', () => {
  it('accepts created and shown reveals only when they started parked', () => {
    expect(isPassingRevealEvidence({ outcome: 'created', parked: true })).toBe(true)
    expect(isPassingRevealEvidence({ outcome: 'shown', parked: true })).toBe(true)
    expect(isPassingRevealEvidence({ outcome: 'shown', parked: false })).toBe(false)
    expect(isPassingRevealEvidence({ outcome: 'already-visible', parked: true })).toBe(false)
    expect(isPassingRevealEvidence(null)).toBe(false)
  })
})

describe('waitUntilParked', () => {
  it('resolves when smoke-park-state.json reports parked after sinceMs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-park-prove-'))
    try {
      const since = Date.now() - 1_000
      writeFileSync(
        join(dir, 'smoke-park-state.json'),
        JSON.stringify({ at: Date.now(), parked: true, visible: true, layout: 'hide' })
      )
      const state = await waitUntilParked(dir, since, 2_000)
      expect(state?.parked).toBe(true)
      expect(state?.layout).toBe('hide')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('times out when the marker stays unparked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-park-prove-'))
    try {
      writeFileSync(
        join(dir, 'smoke-park-state.json'),
        JSON.stringify({ at: Date.now(), parked: false, visible: true, layout: 'hide' })
      )
      const state = await waitUntilParked(dir, 0, 400)
      expect(state).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('runRevealRow', () => {
  it('takes the reveal baseline after smoke prep so a prep second-instance cannot satisfy the row', async () => {
    const rows = initialRvRows('darwin')
    const reveals: Array<{ event: string; reason: string; outcome: string; parked: boolean; layout: string }> = []
    let exercisedReopen = false

    await runRevealRow({
      auditLogPath: '/tmp/metis-smoke-audit.log',
      rows,
      id: 'RV-2-macos-open-new-instance',
      reason: 'second-instance',
      prepare: async () => {
        reveals.push({ event: 'reveal', reason: 'second-instance', outcome: 'shown', parked: true, layout: 'hide' })
        return { error: false }
      },
      run: async () => {
        exercisedReopen = true
        return { error: false }
      },
      countReveals: (_auditLogPath, reason) => reveals.filter((record) => record.reason === reason).length,
      waitForRevealRecord: async (_auditLogPath, reason, seenCount) =>
        reveals.filter((record) => record.reason === reason)[seenCount] ?? null,
      failure: 'missing second-instance reveal'
    })

    expect(exercisedReopen).toBe(true)
    expect(rows.find((row) => row.id === 'RV-2-macos-open-new-instance')).toMatchObject({
      status: 'FAIL',
      evidence: null,
      unblock: 'missing second-instance reveal'
    })
  })

  const auditLine = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`

  it('waits for a detached relaunch reveal that lands after run() resolves, within the row reveal window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-rv-row-'))
    const auditLogPath = join(dir, 'audit.log')
    try {
      writeFileSync(auditLogPath, auditLine({ event: 'app.renderer.ready' }))
      const rows = initialRvRows('win32')
      let waitedWith: number | undefined

      await runRevealRow({
        auditLogPath,
        rows,
        id: 'RV-3-windows-shortcut-relaunch',
        reason: 'second-instance',
        prepare: async () => ({ code: 0, signal: null, error: false }),
        run: async () => {
          // The shortcut's cmd launcher detaches Metis.exe: the relaunched instance hands off after run() returns.
          setTimeout(() => {
            appendFileSync(auditLogPath, auditLine({ event: 'reveal', reason: 'second-instance', outcome: 'shown', parked: true, layout: 'hide' }))
          }, 300)
          return { code: 0, signal: null, error: false }
        },
        revealTimeoutMs: 3_000,
        waitForRevealRecord: async (path, reason, seenCount, timeoutMs) => {
          waitedWith = timeoutMs
          const deadline = Date.now() + (timeoutMs ?? 0)
          while (Date.now() < deadline) {
            const matches = parseAuditLog(readFileSync(path, 'utf8')).filter((r) => r.event === 'reveal' && r.reason === reason)
            if (matches.length > seenCount) return matches[matches.length - 1]
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
          return null
        },
        failure: 'missing Windows shortcut reveal'
      })

      expect(waitedWith).toBe(3_000)
      const row = rows.find((entry) => entry.id === 'RV-3-windows-shortcut-relaunch')
      expect(row).toMatchObject({ status: 'PASS', unblock: null })
      expect(row).not.toHaveProperty('diagnostics')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('on failure records the launch outcome and the content-free audit events around the relaunch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-rv-row-'))
    const auditLogPath = join(dir, 'audit.log')
    const secret = 'C:/Users/someone/private-meeting.txt'
    try {
      writeFileSync(
        auditLogPath,
        auditLine({ event: 'app.started', version: '1.0.0', message: secret }) +
          auditLine({ event: 'app.renderer.ready' })
      )
      const rows = initialRvRows('win32')

      await runRevealRow({
        auditLogPath,
        rows,
        id: 'RV-3-windows-shortcut-relaunch',
        reason: 'second-instance',
        prepare: async () => {
          appendFileSync(auditLogPath, auditLine({ event: 'reveal', reason: 'second-instance', outcome: 'shown', parked: false, isVisible: true, layout: 'hide', ms: 2 }))
          return { code: 0, signal: null, error: false }
        },
        run: async () => {
          appendFileSync(auditLogPath, auditLine({ event: 'security.ipc_denied', reason: secret }))
          return { code: null, signal: 'timeout', error: false }
        },
        revealTimeoutMs: 300,
        failure: 'missing Windows shortcut reveal'
      })

      const row = rows.find((entry) => entry.id === 'RV-3-windows-shortcut-relaunch') as { diagnostics?: unknown } | undefined
      expect(row).toMatchObject({ status: 'FAIL', evidence: null, unblock: 'missing Windows shortcut reveal' })
      expect(row?.diagnostics).toEqual({
        stage: 'no-reveal',
        prepare: { code: 0, signal: null, error: false },
        launch: { code: null, signal: 'timeout', error: false },
        waitedMs: expect.any(Number),
        auditBefore: [
          { event: 'app.started' },
          { event: 'app.renderer.ready' },
          { event: 'reveal', reason: 'second-instance', outcome: 'shown', isVisible: true, parked: false, layout: 'hide', ms: 2 }
        ],
        auditAfter: [{ event: 'security.ipc_denied' }]
      })
      expect(JSON.stringify(row)).not.toContain(secret)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('names the prepare stage when the row never got to relaunch', async () => {
    const rows = initialRvRows('win32')
    let launched = false

    await runRevealRow({
      auditLogPath: join(tmpdir(), 'metis-rv-row-absent', 'audit.log'),
      rows,
      id: 'RV-3-windows-shortcut-relaunch',
      reason: 'second-instance',
      prepare: async () => ({ code: 1, signal: null, error: true }),
      run: async () => {
        launched = true
        return { code: 0, signal: null, error: false }
      },
      failure: 'missing Windows shortcut reveal'
    })

    expect(launched).toBe(false)
    const row = rows.find((entry) => entry.id === 'RV-3-windows-shortcut-relaunch') as { diagnostics?: unknown } | undefined
    expect(row?.diagnostics).toMatchObject({
      stage: 'prepare',
      prepare: { code: 1, signal: null, error: true },
      launch: null,
      auditBefore: [],
      auditAfter: []
    })
  })
})

describe('auditDiagnostic', () => {
  it('keeps only the event name of non-reveal records and the typed projection fields of reveals', () => {
    expect(auditDiagnostic({ event: 'app.crash', message: 'stack with /private/path' })).toEqual({ event: 'app.crash' })
    expect(auditDiagnostic({ event: 'reveal', reason: 'tray', outcome: 'failed', parked: true, detail: { nested: 'x' } })).toEqual({
      event: 'reveal',
      reason: 'tray',
      outcome: 'failed',
      parked: true
    })
    expect(auditDiagnostic({ seq: 3 })).toEqual({ event: null })
  })
})

describe('smokeReport', () => {
  it('returns exactly the schema-1 key set and leaks no path, command-line or audit detail', () => {
    const secretPath = '/opt/smoke/should-not-leak/crash.log'
    const secretBootId = 'BOOT-SECRET-1234'
    const observation = {
      ...goodObservation(),
      ownedAtQuit: [
        { pid: 100, ppid: 1, startedMs: 1000, exe: `/opt/smoke/secret/Metis.app/Contents/MacOS/Metis`, role: 'Metis' }
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
      'rv',
      'navigationGuard',
      'rightEdgeHide',
      'processes'
    ])
    expect(Object.keys(report.app ?? {})).toEqual(['version', 'platform', 'arch'])
    expect(Object.keys(report.events)).toEqual(LIFECYCLE_EVENTS)
    expect(serialized).not.toContain(secretPath)
    expect(serialized).not.toContain(secretBootId)
    expect(serialized).not.toContain('/opt/smoke/secret')
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
      rv: initialRvRows('darwin'),
      navigationGuard: initialNavigationGuardRows(),
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

describe('right-edge Hide rows (RE-HIDE)', () => {
  const display: DisplayMetrics = {
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    workArea: { x: 0, y: 33, width: 1512, height: 949 },
    hasNotch: true,
    notchWidth: 200,
    menuBarHeight: 33,
    source: 'helper'
  }

  it('tracks every RE-HIDE scenario as pending automation, meeting rows last', () => {
    const rows = initialRightEdgeHideRows()
    expect(rows.map((row) => row.id)).toEqual([
      'RE-HIDE-1-edge-reveals',
      'RE-HIDE-2-inset-stays-parked',
      'RE-HIDE-3-draft-hide-and-escape',
      'RE-HIDE-5-toggle-hide-latches',
      'RE-HIDE-6-toggle-reveals-hide',
      'RE-HIDE-6-toggle-reveals-island',
      'RE-HIDE-7-layout-change-chrome',
      'RE-HIDE-3-meeting-hide',
      'RE-HIDE-4-island-meeting-leave-parks'
    ])
    expect(rows.every((row) => row.status === 'PENDING' && row.evidence === null && row.unblock === null)).toBe(true)
  })

  it('expects exactly the geometry main computes for a fresh profile', () => {
    const expected = rightEdgeExpectedRects(display.workArea)
    expect(expected.drawer).toEqual(rightEdgeSidecarBounds(display, { open: true }))
    expect(expected.tab).toEqual(rightEdgeSidecarBounds(display, { open: false }))
    expect(expected.band).toEqual(parkAfterExclusiveOnboarding('hide', display, 8, 'right-edge'))
    expect(expected.band).toEqual(hoverWatchRestRect('hide', display, 'right-edge'))
    expect(expected.tab).toEqual(parkAfterExclusiveOnboarding('island', display, 8, 'right-edge'))
  })

  it('accepts only the documented revealed and parked chrome', () => {
    const { drawer, tab, band } = rightEdgeExpectedRects(display.workArea)
    const win = (bounds: { x: number; y: number; width: number; height: number }, opacity: number, clickThrough: boolean | null) => ({
      bounds,
      opacity,
      clickThrough,
      visible: true,
      displayBounds: display.bounds,
      workArea: display.workArea
    })
    const page = { drawer: false, rail: true, hideControl: false, meetingLive: false, composerFocused: false, draft: '' }
    const open = { ...page, drawer: true, rail: false, hideControl: true }
    expect(rightEdgeStateMatches({ win: win(drawer, 1, false), page: open }, 'revealed')).toBe(true)
    expect(rightEdgeStateMatches({ win: win(drawer, 1, true), page: open }, 'revealed')).toBe(false)
    expect(rightEdgeStateMatches({ win: win(drawer, 1, false), page }, 'revealed')).toBe(false)
    expect(rightEdgeStateMatches({ win: win(band, 0, true), page }, 'parked', 'hide')).toBe(true)
    // The 1.9.6 park: the inset tab, invisible and click-through, is not a Hide park any more.
    expect(rightEdgeStateMatches({ win: win(tab, 0, true), page }, 'parked', 'hide')).toBe(false)
    expect(rightEdgeStateMatches({ win: win(band, 1, true), page }, 'parked', 'hide')).toBe(false)
    expect(rightEdgeStateMatches({ win: win(tab, 1, false), page }, 'parked', 'island')).toBe(true)
    // An open drawer rendered inside a parked window is the RE-HIDE-4 failure.
    expect(rightEdgeStateMatches({ win: win(tab, 1, false), page: open }, 'parked', 'island')).toBe(false)
    expect(rightEdgeStateMatches({ win: win(tab, 0, false), page }, 'parked', 'island')).toBe(false)
  })

  // Windows packaged smoke: a 1024x768 runner with a 48 px taskbar and a 32 px minimum window width.
  const windows: DisplayMetrics = {
    bounds: { x: 0, y: 0, width: 1024, height: 768 },
    workArea: { x: 0, y: 0, width: 1024, height: 720 },
    hasNotch: false,
    notchWidth: 0,
    menuBarHeight: 0,
    source: 'heuristic'
  }

  it('matches main on the Windows runner work area, including the Island rail y', () => {
    const expected = rightEdgeExpectedRects(windows.workArea)
    expect(expected.drawer).toEqual(rightEdgeSidecarBounds(windows, { open: true }))
    expect(expected.tab).toEqual(parkAfterExclusiveOnboarding('island', windows, 8, 'right-edge'))
    expect(expected.band).toEqual(parkAfterExclusiveOnboarding('hide', windows, 8, 'right-edge'))
    // The observed Windows parks: Island rail at y 141, Hide band at the drawer's y 39.
    expect(expected.tab).toEqual({ x: 960, y: 141, width: 52, height: 52 })
    expect(expected.band.y).toBe(39)
  })

  it('accepts a Hide park the OS widened only when its right edge stays at the work-area edge', () => {
    const { band } = rightEdgeExpectedRects(windows.workArea)
    const edge = windows.workArea.x + windows.workArea.width
    const win = (bounds: { x: number; y: number; width: number; height: number }) => ({
      bounds,
      opacity: 0,
      clickThrough: true,
      visible: true,
      displayBounds: windows.bounds,
      workArea: windows.workArea
    })
    const page = { dock: true, drawer: false, rail: true, hideControl: false, meetingLive: false, composerFocused: false, draft: '' }
    const flush = { x: edge - 32, y: band.y, width: 32, height: band.height }
    expect(rightEdgeHideParkMatches(flush, band)).toBe(true)
    expect(rightEdgeStateMatches({ win: win(flush), page }, 'parked', 'hide')).toBe(true)
    // Run 36575074348: widened at the requested x, the window crossed the work-area edge.
    const crossing = { x: band.x, y: band.y, width: 32, height: band.height }
    expect(rightEdgeHideParkMatches(crossing, band)).toBe(false)
    expect(rightEdgeStateMatches({ win: win(crossing), page }, 'parked', 'hide')).toBe(false)
    // Inset from the edge, or the old tab square, is still not a Hide park.
    expect(rightEdgeHideParkMatches({ ...flush, x: flush.x - 12 }, band)).toBe(false)
    expect(rightEdgeHideParkMatches(rightEdgeExpectedRects(windows.workArea).tab, band)).toBe(false)
  })

  it('names the parked criteria a Windows readback misses, so a failing row says which one', () => {
    // Run 36645827157 readback: the widened band flush at the edge is a bounds match.
    const bounds = { x: 992, y: 39, width: 32, height: 560 }
    const win = (opacity: number, clickThrough: boolean | null) => ({ bounds, opacity, clickThrough, visible: true, displayBounds: windows.bounds, workArea: windows.workArea })
    const page = { dock: true, drawer: false, rail: true, hideControl: false, meetingLive: false, composerFocused: false, draft: '' }
    expect(rightEdgeStateMismatches({ win: win(0, true), page }, 'parked', 'hide')).toEqual([])
    expect(rightEdgeStateMismatches({ win: win(0, true), page: { ...page, drawer: true, rail: false } }, 'parked', 'hide')).toEqual(['drawer'])
    expect(rightEdgeStateMismatches({ win: win(1, false), page }, 'parked', 'hide')).toEqual(['opacity', 'clickThrough'])
    expect(rightEdgeStateMismatches({ win: win(0, null), page }, 'parked', 'hide')).toEqual(['clickThrough'])
    expect(rightEdgeStateMismatches({ win: win(0, true), page }, 'parked', 'island')).toEqual(['bounds', 'opacity', 'clickThrough'])
    expect(rightEdgeStateMismatches(null, 'parked', 'hide')).toEqual(['observation'])
  })
})

describe('initialRvRows', () => {
  it('tracks every macOS hosted reopen row as pending automation', () => {
    const rows = initialRvRows('darwin')

    expect(rows.map((row) => row.id)).toEqual([
      'RV-1-macos-open-activate',
      'RV-2-macos-open-new-instance',
      'RV-4-tray-show',
      'RV-4-global-hotkey',
      'RV-1-macos-finder-spotlight-launchpad',
      'RV-boot-launch-activate-stays-parked'
    ])
    expect(rows.every((row) => row.status === 'PENDING')).toBe(true)
    expect(rows.every((row) => row.unblock === null)).toBe(true)
  })

  it('tracks every Windows hosted reopen row as pending automation', () => {
    const rows = initialRvRows('win32')

    expect(rows.map((row) => row.id)).toEqual([
      'RV-3-windows-exe-relaunch',
      'RV-4-tray-show',
      'RV-4-global-hotkey',
      'RV-3-windows-shortcut-relaunch'
    ])
    expect(rows.every((row) => row.status === 'PENDING')).toBe(true)
    expect(rows.every((row) => row.unblock === null)).toBe(true)
  })
})

describe('initialNavigationGuardRows', () => {
  it('tracks clean and dirty History navigation entry points as pending automation', () => {
    const rows = initialNavigationGuardRows()

    expect(rows.map((row) => row.id)).toEqual([
      'HIST-clean-bar-open',
      'HIST-clean-settings-open',
      'HIST-clean-row-doubleclick',
      'HIST-clean-bottom-open',
      'HIST-clean-back',
      'HIST-clean-recent-meeting',
      'HIST-dirty-cancel-bar',
      'HIST-dirty-discard-bar',
      'HIST-dirty-save-bar',
      'HIST-dirty-cancel-settings-open',
      'HIST-dirty-discard-settings-open',
      'HIST-dirty-save-settings-open',
      'HIST-dirty-cancel-back',
      'HIST-dirty-discard-back',
      'HIST-dirty-save-back',
      'HIST-dirty-cancel-recent',
      'HIST-dirty-discard-recent',
      'HIST-dirty-save-recent'
    ])
    expect(rows.some((row) => row.state === 'clean')).toBe(true)
    expect(rows.some((row) => row.state === 'dirty')).toBe(true)
    expect(rows.every((row) => row.status === 'PENDING')).toBe(true)
    expect(rows.every((row) => row.unblock === null)).toBe(true)
  })
})

describe('navigationMeetingTitles', () => {
  it('keeps the original seeded names for clean rows and gives dirty rows isolated meeting pairs', () => {
    expect(navigationMeetingTitles()).toEqual({
      alpha: 'Smoke navigation alpha',
      beta: 'Smoke navigation beta'
    })

    expect(navigationMeetingTitles('HIST dirty save bar')).toEqual({
      alpha: 'Smoke navigation alpha HIST dirty save bar',
      beta: 'Smoke navigation beta HIST dirty save bar'
    })
  })
})

describe('seedOnboardedProfile', () => {
  it('writes a plain-JSON settings.json that skips onboarding and keeps a hover-parkable overlay layout', () => {
    const profile = mkdtempSync(join(tmpdir(), 'metis-smoke-test-'))
    try {
      seedOnboardedProfile(profile)
      const settings = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'))

      expect(settings.onboardingDone).toBe(true)
      expect(typeof settings.onboardingDoneAt).toBe('number')
      expect(settings.overlayLayout).toBe('hide')
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  })
})

describe('buildWindowsShortcutLauncher', () => {
  it('points the .lnk at a launcher that carries the isolated ASKTOTO_USERDATA and reopen probe into Metis.exe', () => {
    const built = buildWindowsShortcutLauncher({
      auditLogDir: 'C:\\Users\\runner\\AppData\\Local\\Temp\\metis-smoke-xyz\\logs',
      executable: 'C:\\Program Files\\Metis\\Metis.exe',
      userData: 'C:\\Users\\runner\\AppData\\Local\\Temp\\metis-smoke-xyz',
      reopenProbe: '1'
    })

    expect(built.shortcutPath.replace(/\\/g, '/')).toMatch(/Metis-smoke\.lnk$/)
    expect(built.launcherPath.replace(/\\/g, '/')).toMatch(/Metis-smoke-launch\.cmd$/)
    expect(built.launcherBody).toContain('set "ASKTOTO_USERDATA=C:\\Users\\runner\\AppData\\Local\\Temp\\metis-smoke-xyz"')
    expect(built.launcherBody).toContain('set "ASKTOTO_SMOKE_REOPEN_PROBE=1"')
    expect(built.launcherBody).toContain(`start "" ${JSON.stringify('C:\\Program Files\\Metis\\Metis.exe')}`)
    expect(built.shortcutScript).toContain('CreateShortcut')
    expect(built.shortcutScript).toContain('Metis-smoke-launch.cmd')
    expect(built.shortcutScript).toContain('WorkingDirectory')
  })

  it('creates the .lnk in one script and opens it in another, so COM activation never spends the relaunch budget', () => {
    const built = buildWindowsShortcutLauncher({
      auditLogDir: 'C:\\tmp\\logs',
      executable: 'C:\\Metis\\Metis.exe',
      userData: 'C:\\tmp\\profile'
    })

    expect(built.shortcutScript).toContain('$shortcut.Save()')
    expect(built.shortcutScript).not.toContain('Start-Process')
    expect(built.launchScript).toBe(`Start-Process -FilePath ${JSON.stringify(built.shortcutPath)}`)
    expect(built.launchScript).not.toContain('ComObject')
  })

  it('refuses to build a launcher without ASKTOTO_USERDATA, rather than silently dropping the isolated profile', () => {
    expect(() =>
      buildWindowsShortcutLauncher({
        auditLogDir: 'C:\\tmp\\logs',
        executable: 'C:\\Metis\\Metis.exe',
        userData: ''
      })
    ).toThrow(/ASKTOTO_USERDATA/)
  })
})

describe('NAVIGATION_GUARD_BOOTSTRAP_PATCH', () => {
  it('is a completed-onboarding, bar-layout, auto-hide-off settings patch — the same shape a real user leaves after picking the bar layout and finishing onboarding', () => {
    expect(NAVIGATION_GUARD_BOOTSTRAP_PATCH).toEqual({
      onboardingDone: true,
      recordingConsent: true,
      overlayLayout: 'bar',
      autoHideOverlay: false
    })
  })
})

describe('CLI', () => {
  it('exits 2 with usage when called with no arguments', () => {
    const scriptPath = fileURLToPath(new URL('./packaged-smoke.mjs', import.meta.url))

    const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('usage')
  })
})

describe('readObservationTail', () => {
  it('returns an empty audit and a null marker when this run never created a profile', () => {
    expect(readObservationTail(null)).toEqual({ audit: [], marker: null })
  })

  it('reads back the audit log and the clean-shutdown marker from a real profile directory', () => {
    const profile = mkdtempSync(join(tmpdir(), 'metis-smoke-test-'))
    try {
      mkdirSync(join(profile, 'logs'), { recursive: true })
      writeFileSync(join(profile, 'logs', 'audit.log'), '{"event":"app.started"}\n{"event":"app.shutdown.clean"}\n')
      writeFileSync(join(profile, 'run-state.json'), JSON.stringify({ clean: true }))

      expect(readObservationTail(profile)).toEqual({
        audit: [{ event: 'app.started' }, { event: 'app.shutdown.clean' }],
        marker: true
      })
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  })

  it('reports marker false, never null, when a profile exists but never wrote a clean run-state', () => {
    const profile = mkdtempSync(join(tmpdir(), 'metis-smoke-test-'))
    try {
      expect(readObservationTail(profile)).toEqual({ audit: [], marker: false })
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
  })
})

describe('childPidReserved', () => {
  it('is true only for a child with a numeric pid that has not exited', () => {
    expect(childPidReserved({ pid: 100, exitCode: null, signalCode: null })).toBe(true)
    expect(childPidReserved({ pid: 100, exitCode: 0, signalCode: null })).toBe(false)
    expect(childPidReserved({ pid: 100, exitCode: null, signalCode: 'SIGTERM' })).toBe(false)
    expect(childPidReserved({ pid: undefined, exitCode: null, signalCode: null })).toBe(false)
    expect(childPidReserved(null)).toBe(false)
  })
})

describe('computeCleanupTargets', () => {
  const installRoot = '/opt/smoke/Metis.app'
  const platform = 'darwin'

  it('kills nothing when this run never launched a child, even if the root already has residents', () => {
    // The install_root_busy path: the pre-launch check found these and refused to own them.
    const preExisting = { pid: 9, ppid: 1, startedMs: 1, exe: `${installRoot}/Contents/MacOS/Metis`, role: 'Metis' }

    const targets = computeCleanupTargets(
      { child: null, ownedAtQuit: null, mainPid: null, installRoot, platform },
      [preExisting]
    )

    expect(targets).toEqual([])
  })

  it('does not adopt a recycled pid once the child has already exited', () => {
    const child = { pid: 100, exitCode: 0, signalCode: null }
    const recycled = { pid: 100, ppid: 1, startedMs: 5000, exe: '/usr/bin/unrelated', role: 'unrelated' }
    const recycledChild = {
      pid: 105,
      ppid: 100,
      startedMs: 5001,
      exe: '/usr/bin/unrelated-child',
      role: 'unrelated-child'
    }

    const targets = computeCleanupTargets(
      { child, ownedAtQuit: [], mainPid: 100, installRoot, platform },
      [recycled, recycledChild]
    )

    expect(targets).toEqual([])
  })

  it('kills survivors of the run baseline, and, while the child pid is still live, its current owned set', () => {
    const child = { pid: 100, exitCode: null, signalCode: null }
    const main = { pid: 100, ppid: 1, startedMs: 1000, exe: `${installRoot}/Contents/MacOS/Metis`, role: 'Metis' }
    const helper = { pid: 101, ppid: 100, startedMs: 1001, exe: '/opt/elsewhere/helper', role: 'helper' }

    const targets = computeCleanupTargets(
      { child, ownedAtQuit: [main], mainPid: 100, installRoot, platform },
      [main, helper]
    )

    expect(targets.map((t) => t.pid).sort((a, b) => a - b)).toEqual([100, 101])
  })
})

describe('bootLaunchActivateVerdict', () => {
  const passing = { precondition: null, rendererReady: true, activateReveals: 0, parked: true, settingsOpened: false }

  it('passes only when the launch activate revealed nothing, the overlay is parked and Settings stayed closed', () => {
    expect(bootLaunchActivateVerdict(passing)).toEqual({ status: 'PASS', failures: [], reason: null })
  })

  it('fails when an activate reveal was honoured during boot', () => {
    expect(bootLaunchActivateVerdict({ ...passing, activateReveals: 1 })).toMatchObject({
      status: 'FAIL',
      failures: ['activate_reveal_during_boot']
    })
  })

  it('fails when the overlay is not parked after boot, or parked was never observed', () => {
    expect(bootLaunchActivateVerdict({ ...passing, parked: false })).toMatchObject({
      status: 'FAIL',
      failures: ['not_parked_after_boot']
    })
    expect(bootLaunchActivateVerdict({ ...passing, parked: null }).status).toBe('FAIL')
  })

  it('fails when Settings opened, or its state was never observed', () => {
    expect(bootLaunchActivateVerdict({ ...passing, settingsOpened: true })).toMatchObject({
      status: 'FAIL',
      failures: ['settings_opened_on_boot']
    })
    expect(bootLaunchActivateVerdict({ ...passing, settingsOpened: null }).status).toBe('FAIL')
  })

  it('reports every defect at once', () => {
    expect(bootLaunchActivateVerdict({ ...passing, activateReveals: 2, parked: false, settingsOpened: true }).failures).toEqual([
      'activate_reveal_during_boot',
      'not_parked_after_boot',
      'settings_opened_on_boot'
    ])
  })

  it('is PRECONDITION, never PASS, when the env or CDP port could not be delivered', () => {
    const verdict = bootLaunchActivateVerdict({ ...passing, precondition: 'the CDP port did not reach the app' })
    expect(verdict).toEqual({ status: 'PRECONDITION', failures: [], reason: 'the CDP port did not reach the app' })
  })

  it('is PRECONDITION when the renderer never became ready', () => {
    expect(bootLaunchActivateVerdict({ ...passing, rendererReady: false }).status).toBe('PRECONDITION')
  })
})
