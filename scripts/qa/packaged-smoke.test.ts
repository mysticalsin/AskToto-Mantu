import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  LIFECYCLE_EVENTS,
  childPidReserved,
  computeCleanupTargets,
  isOverlayUrl,
  isPassingRevealEvidence,
  parseAuditLog,
  readObservationTail,
  runProcess,
  seedSmokeProfile,
  initialRvRows,
  initialNavigationGuardRows,
  runRevealRow,
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
    evidence: {
      event: string
      reason: string
      outcome: string | null
      isVisible?: boolean
      parked?: boolean
      layout?: string | null
    } | null
    diagnosis: {
      rootCause: string
      revealEventsBefore: number
      revealEventsAfter: number
      driverExit: { code: number | null; signal: string | null; error: boolean }
    } | null
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
        diagnosis: {
          rootCause: 'reopen_revealed_window',
          revealEventsBefore: 0,
          revealEventsAfter: 1,
          driverExit: { code: 0, signal: null, error: false }
        },
        unblock: null
      },
      {
        id: 'RV-2-macos-open-new-instance',
        reason: 'second-instance',
        automation: 'open-new-instance',
        status: 'PASS',
        evidence: { event: 'reveal', reason: 'second-instance', outcome: 'shown', parked: true, layout: 'hide' },
        diagnosis: {
          rootCause: 'reopen_revealed_window',
          revealEventsBefore: 0,
          revealEventsAfter: 1,
          driverExit: { code: 0, signal: null, error: false }
        },
        unblock: null
      },
      {
        id: 'RV-4-tray-show',
        reason: 'tray',
        automation: 'tray-menu',
        status: 'PASS',
        evidence: { event: 'reveal', reason: 'tray', outcome: 'shown', parked: true, layout: 'hide' },
        diagnosis: {
          rootCause: 'reopen_revealed_window',
          revealEventsBefore: 0,
          revealEventsAfter: 1,
          driverExit: { code: 0, signal: null, error: false }
        },
        unblock: null
      },
      {
        id: 'RV-4-global-hotkey',
        reason: 'hotkey',
        automation: 'global-hotkey',
        status: 'PASS',
        evidence: { event: 'reveal', reason: 'hotkey', outcome: 'shown', parked: true, layout: 'hide' },
        diagnosis: {
          rootCause: 'reopen_revealed_window',
          revealEventsBefore: 0,
          revealEventsAfter: 1,
          driverExit: { code: 0, signal: null, error: false }
        },
        unblock: null
      },
      {
        id: 'RV-1-macos-finder-spotlight-launchpad',
        reason: 'activate',
        automation: 'finder-open-app-file',
        status: 'PASS',
        evidence: { event: 'reveal', reason: 'activate', outcome: 'shown', parked: true, layout: 'hide' },
        diagnosis: {
          rootCause: 'reopen_revealed_window',
          revealEventsBefore: 0,
          revealEventsAfter: 1,
          driverExit: { code: 0, signal: null, error: false }
        },
        unblock: null
      }
    ],
    navigationGuard: initialNavigationGuardRows().map((row) => ({
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
  it('accepts created and shown reveals when the route made a parked or hidden window visible', () => {
    expect(isPassingRevealEvidence({ outcome: 'created', parked: true })).toBe(true)
    expect(isPassingRevealEvidence({ outcome: 'shown', parked: true })).toBe(true)
    expect(isPassingRevealEvidence({ outcome: 'shown', parked: false, isVisible: false })).toBe(true)
    expect(isPassingRevealEvidence({ outcome: 'shown', parked: false, isVisible: true })).toBe(false)
    expect(isPassingRevealEvidence({ outcome: 'already-visible', parked: true })).toBe(false)
    expect(isPassingRevealEvidence(null)).toBe(false)
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
      diagnosis: {
        rootCause: 'missing_reveal_audit_event',
        revealEventsBefore: 1,
        revealEventsAfter: 1,
        driverExit: { code: null, signal: null, error: false }
      },
      unblock: 'missing second-instance reveal'
    })
  })

  it('records driver failure as the row root cause instead of blaming app reveal code', async () => {
    const rows = initialRvRows('darwin')

    await runRevealRow({
      auditLogPath: '/tmp/metis-smoke-audit.log',
      rows,
      id: 'RV-1-macos-open-activate',
      reason: 'activate',
      prepare: undefined,
      run: async () => ({ code: 7, signal: null, error: true }),
      countReveals: () => 0,
      waitForRevealRecord: async () => {
        throw new Error('wait must not run after a failed driver')
      },
      failure: 'activate driver failed'
    })

    expect(rows.find((row) => row.id === 'RV-1-macos-open-activate')).toMatchObject({
      status: 'FAIL',
      evidence: null,
      diagnosis: {
        rootCause: 'reopen_driver_failed',
        revealEventsBefore: 0,
        revealEventsAfter: 0,
        driverExit: { code: 7, signal: null, error: true }
      },
      unblock: 'activate driver failed'
    })
  })
})

describe('runProcess', () => {
  it('reports a timeout as an error so a stuck duplicate app cannot leave orphan helpers unnoticed', async () => {
    const result = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], 25)

    expect(result).toEqual({ code: null, signal: 'timeout', error: true })
  })

  it('reports non-zero exits as errors for reopen driver commands', async () => {
    const result = await runProcess(process.execPath, ['-e', 'process.exit(7)'], 1_000)

    expect(result).toEqual({ code: 7, signal: null, error: true })
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

describe('initialRvRows', () => {
  it('tracks every macOS hosted reopen row as pending automation', () => {
    const rows = initialRvRows('darwin')

    expect(rows.map((row) => row.id)).toEqual([
      'RV-1-macos-open-activate',
      'RV-2-macos-open-new-instance',
      'RV-4-tray-show',
      'RV-4-global-hotkey',
      'RV-1-macos-finder-spotlight-launchpad'
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

describe('seedSmokeProfile', () => {
  it('starts packaged smoke in the normal parked overlay, not first-run onboarding', () => {
    const profile = mkdtempSync(join(tmpdir(), 'metis-smoke-test-'))
    try {
      seedSmokeProfile(profile, 1234)

      expect(JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'))).toEqual({
        onboardingDone: true,
        onboardingDoneAt: 1234,
        recordingConsent: true,
        overlayLayout: 'hide',
        overlayPlacement: 'top-center',
        autoHideOverlay: true
      })
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
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
