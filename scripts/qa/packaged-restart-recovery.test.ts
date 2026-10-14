import { describe, expect, it } from 'vitest'
import {
  RECOVERY_ASSERTIONS,
  RECOVERY_REPORT_SCHEMA,
  mergeOwnedProcessBaselines,
  packagedRecoveryReportProblems,
  releaseCandidateTransports,
  requestQuitAcknowledgement,
  shutdownVerdict
} from './packaged-restart-recovery.mjs'
import {
  SCENARIOS,
  assessPackagedRecoveryReport,
  installerKindForScenario,
  laneRecord,
  resolveScenario,
  scenarioCommand
} from './candidate-scenarios.mjs'

const MAC_SHA = 'a'.repeat(64)
const WIN_SHA = 'b'.repeat(64)

function report() {
  return {
    schema: RECOVERY_REPORT_SCHEMA,
    scenario: 'packaged-restart-recovery',
    platform: 'darwin',
    outcome: 'PASS',
    assertions: RECOVERY_ASSERTIONS.map((id) => ({ id, status: 'PASS' })),
    failure: 'none',
    teardown: 'ACKNOWLEDGED'
  }
}

describe('packaged restart recovery candidate scenario', () => {
  it('binds to both promotable installers and a fresh isolated profile', () => {
    const scenario = SCENARIOS['packaged-restart-recovery']
    expect(scenario.ticket).toBe('WORKSTREAM-electron-packaged-acceptance')
    expect(scenario.m2Crosswalk).toBe('UNKNOWN')
    expect(scenario.reportAssessment).toBe('packaged-restart-recovery')
    expect(RECOVERY_REPORT_SCHEMA).toBe('metis.packaged-restart-recovery.v2')
    expect(RECOVERY_ASSERTIONS).toContain('note-readable-after-restart')
    expect(RECOVERY_ASSERTIONS).toContain('note-bytes-preserved')
    expect(Object.keys(scenario.platforms)).toEqual(['mac', 'win'])
    expect(scenario.platforms.mac).toMatchObject({
      variant: 'mac',
      artifact: 'candidate-mac',
      installerKind: 'mac-dmg',
      installerSuffix: '.dmg',
      isolatedProfiles: true,
      timeoutMinutes: 30,
      stepTimeoutMinutes: 20
    })
    expect(scenario.platforms.win).toMatchObject({
      variant: 'win',
      artifact: 'candidate-win',
      isolatedProfiles: true,
      timeoutMinutes: 30,
      stepTimeoutMinutes: 20
    })
    expect(installerKindForScenario('packaged-restart-recovery', 'mac')).toBe('mac-dmg')
    expect(installerKindForScenario('packaged-restart-recovery', 'win')).toBe('win')
    expect(resolveScenario({
      scenario: 'packaged-restart-recovery',
      sha256: { mac: MAC_SHA, win: WIN_SHA }
    })).toMatchObject({
      mac: { variant: 'mac', artifact: 'candidate-mac', sha256: MAC_SHA },
      win: { variant: 'win', artifact: 'candidate-win', sha256: WIN_SHA }
    })
  })

  it.each([
    ['mac', 'assets/Metis-2.0.0.dmg', '../../_temp/candidate-install/Metis.app'],
    ['win', 'assets/Metis-Setup-2.0.0.exe', '../../_temp/candidate-install/Metis.exe']
  ])('runs on the installed %s app path', (platform, installer, app) => {
    const argv = scenarioCommand({
      scenario: 'packaged-restart-recovery',
      platform,
      installer,
      sha256: platform === 'mac' ? MAC_SHA : WIN_SHA,
      outDir: 'candidate-scenario',
      app
    })
    expect(argv).toEqual([
      'scripts/qa/packaged-restart-recovery.mjs',
      '--app',
      app,
      '--platform',
      platform,
      '--out',
      'candidate-scenario/packaged-restart-recovery.json'
    ])
  })

  it('accepts only the complete fixed-schema report with every recovery assertion PASS', () => {
    expect(packagedRecoveryReportProblems(report())).toEqual([])
    expect(assessPackagedRecoveryReport(report())).toMatchObject({ problems: [], notCovered: [] })
    expect(assessPackagedRecoveryReport(report(), 'mac').problems).toEqual([])
    expect(assessPackagedRecoveryReport(report(), 'win').problems).toContain(
      'packaged recovery report platform does not match the scenario platform.'
    )
  })

  it('records the workstream label and unknown M2 crosswalk without expanding report identity', () => {
    const lane = laneRecord({
      scenario: 'packaged-restart-recovery',
      platform: 'mac',
      env: { GITHUB_RUN_ID: '5151' },
      provenance: { commit: 'c'.repeat(40), run: { id: 4242 } },
      candidateRun: '4242',
      installer: 'Metis-2.0.0.dmg',
      sha256: MAC_SHA,
      argv: ['scripts/qa/packaged-restart-recovery.mjs'],
      exitCode: 0,
      detail: '',
      reportWritten: true,
      reportData: report(),
      reportAssessment: assessPackagedRecoveryReport(report(), 'mac')
    })
    expect(lane).toMatchObject({
      ticket: 'WORKSTREAM-electron-packaged-acceptance',
      m2_crosswalk: 'UNKNOWN',
      outcome: 'PASS'
    })
    expect(lane).not.toHaveProperty('candidate_run_attempt')
  })

  it('rejects missing, duplicate, unknown or nonpassing assertions and unexpected report fields', () => {
    const missing = report()
    missing.assertions.pop()
    expect(packagedRecoveryReportProblems(missing)).toContain('report-schema-invalid')

    const duplicate = report()
    duplicate.assertions[1] = duplicate.assertions[0]
    expect(packagedRecoveryReportProblems(duplicate)).toContain('report-schema-invalid')

    const unknown = { ...report(), privateData: 'synthetic fixture content' }
    expect(packagedRecoveryReportProblems(unknown)).toContain('report-schema-invalid')

    const blocked = report()
    blocked.assertions[0] = { id: RECOVERY_ASSERTIONS[0], status: 'NOT_RUN' }
    expect(packagedRecoveryReportProblems(blocked)).toContain(`${RECOVERY_ASSERTIONS[0]} is NOT_RUN, not PASS.`)
    expect(assessPackagedRecoveryReport(blocked).row_verdicts.recovery).toEqual([
      { id: RECOVERY_ASSERTIONS[0], status: 'NOT_RUN' },
      ...RECOVERY_ASSERTIONS.slice(1).map((id) => ({ id, status: 'PASS' }))
    ])
  })

  it('does not admit a PASS outcome when cleanup or assertions are incomplete', () => {
    const invalid = { ...report(), teardown: 'UNACKNOWLEDGED' }
    expect(packagedRecoveryReportProblems(invalid)).toContain('isolated app teardown was not acknowledged.')
    const failed = { ...report(), outcome: 'FAIL' }
    expect(packagedRecoveryReportProblems(failed)).toContain('packaged restart recovery outcome is FAIL.')
  })

  it('requires an acknowledged quit, normal exit status, and no signal for a clean shutdown', () => {
    const evidence = {
      censusValid: true,
      censusCaptured: true,
      quitAcknowledged: true,
      naturalExit: true,
      exitCode: 0,
      signalCode: null,
      survivorCountAfterGrace: 0,
      survivorCount: 0,
      transportsReleased: true
    }
    expect(shutdownVerdict(evidence)).toEqual({ clean: true, teardown: 'ACKNOWLEDGED' })
    expect(shutdownVerdict({ ...evidence, quitAcknowledged: false }).clean).toBe(false)
    expect(shutdownVerdict({ ...evidence, exitCode: 1 }).clean).toBe(false)
    expect(shutdownVerdict({ ...evidence, exitCode: null, signalCode: 'SIGTERM' }).clean).toBe(false)
    expect(
      shutdownVerdict({ ...evidence, survivorCountAfterGrace: 1, survivorCount: 0 })
    ).toEqual({ clean: false, teardown: 'ACKNOWLEDGED' })
  })

  it('preserves launch-time process ownership when quit-time census loses a reparented helper', () => {
    const launchedMain = { pid: 10, startedMs: 100 }
    const launchedHelper = { pid: 11, startedMs: 101 }
    const quitMain = { pid: 10, startedMs: 100, ppid: 1 }
    const merged = mergeOwnedProcessBaselines(
      [launchedMain, launchedHelper],
      [quitMain]
    )

    expect(merged).toHaveLength(2)
    expect(merged.map(({ pid, startedMs }) => `${pid}:${startedMs}`)).toEqual(['10:100', '11:101'])
    expect(merged[0]).toBe(quitMain)
  })

  it('does not acknowledge a rejected or timed-out quit request', async () => {
    expect(await requestQuitAcknowledgement(() => Promise.reject(new Error('synthetic quit rejection')))).toBe(false)
    expect(await requestQuitAcknowledgement(() => Promise.resolve())).toBe(true)
  })

  it('waits for an uncertain attach release and keeps teardown unacknowledged', async () => {
    let releaseSettled = false
    let releaseBudget = 0
    const transportsReleased = await releaseCandidateTransports({
      browser: null,
      transportUncertain: true,
      lateRelease: async (timeoutMs: number) => {
        releaseBudget = timeoutMs
        await Promise.resolve()
        releaseSettled = true
        return true
      }
    })
    expect(releaseSettled).toBe(true)
    expect(releaseBudget).toBeGreaterThan(0)
    expect(transportsReleased).toBe(false)
    expect(
      shutdownVerdict({
        censusValid: true,
        censusCaptured: true,
        quitAcknowledged: true,
        naturalExit: true,
        exitCode: 0,
        signalCode: null,
        survivorCountAfterGrace: 0,
        survivorCount: 0,
        transportsReleased
      })
    ).toEqual({ clean: false, teardown: 'UNACKNOWLEDGED' })
  })
})
