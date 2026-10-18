import { describe, expect, it } from 'vitest'
import {
  PIN,
  SCHEMA,
  WINDOWS_OS_EXTRA,
  captureSettledAttachment,
  cdpByDeadline,
  classifyCdp,
  classifyInspector,
  inspectorByDeadline,
  osSupersetLaunchEnvironment,
  queryWindowStatus,
  reportProblems,
  sampleWindowAfterDeadline
} from './windows-cdp-env-matrix.mjs'

const paths = {
  root: 'C:\\probe',
  home: 'C:\\probe\\home',
  userProfile: 'C:\\probe\\user',
  appData: 'C:\\probe\\appdata',
  localAppData: 'C:\\probe\\localappdata',
  temp: 'C:\\probe\\tmp',
  userData: 'C:\\probe\\userdata'
}

const snapshot = () => ({
  process: 'RUNNING',
  window_post_deadline: 'POST_DEADLINE_NORMAL_TITLE',
  audit: 'READY',
  protocol_shape: 'INSPECTOR_PROTOCOL_SHAPE_OBSERVED',
  cdp_http_interval: 'REFUSED_OBSERVED',
  inspector_attach_stage: 'DISCOVERY_WAITING',
  host_loop_lag: 'LT_250_MS'
})

const variant = (environment: 'STRICT' | 'OS_SUPERSET') => ({
  environment,
  cdp_15s: 'DEADLINE',
  cdp_45s: 'DEADLINE',
  inspector_15s: 'UNAVAILABLE',
  inspector_45s: 'UNAVAILABLE',
  at_15s: snapshot(),
  at_45s: snapshot(),
  teardown: 'ACKNOWLEDGED',
  transport_release: 'RELEASED'
})

const report = () => ({
  schema: SCHEMA,
  diagnostic_only: true,
  original_acceptance: 'FAIL_CDP_DEADLINE_8_NOT_RUN',
  identity: {
    candidate_run: PIN.candidateRun,
    installer_sha256: PIN.installerSha256,
    producer_commit: PIN.producerCommit,
    harness_commit: 'f'.repeat(40),
    version: PIN.version
  },
  variants: [variant('STRICT'), variant('OS_SUPERSET')]
})

describe('hosted Windows CDP environment matrix', () => {
  it('adds only machine-wide path keys while retaining the fresh profile and excluding secrets', () => {
    const base = {
      PATH: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      ALLUSERSPROFILE: 'C:\\ProgramData',
      CommonProgramFiles: 'C:\\Program Files\\Common Files',
      SystemDrive: 'C:',
      GH_TOKEN: 'must-not-be-passed',
      OPENAI_API_KEY: 'must-not-be-passed',
      ELECTRON_RUN_AS_NODE: '1',
      USERPROFILE: 'C:\\runner-user',
      APPDATA: 'C:\\runner-user\\AppData'
    }
    const env = osSupersetLaunchEnvironment(base, paths)
    expect(env).toMatchObject({
      USERPROFILE: paths.userProfile,
      APPDATA: paths.appData,
      ASKTOTO_USERDATA: paths.userData,
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\probe\\user',
      ALLUSERSPROFILE: 'C:\\ProgramData',
      CommonProgramFiles: 'C:\\Program Files\\Common Files',
      SystemDrive: 'C:'
    })
    for (const name of ['GH_TOKEN', 'OPENAI_API_KEY', 'ELECTRON_RUN_AS_NODE']) expect(env).not.toHaveProperty(name)
    expect(Object.keys(env).filter((key) => !WINDOWS_OS_EXTRA.includes(key))).toEqual(
      Object.keys(osSupersetLaunchEnvironment({ PATH: base.PATH, SystemRoot: base.SystemRoot }, paths))
    )
  })

  it('rejects ambiguous or non-path inherited extras instead of copying arbitrary values', () => {
    expect(() => osSupersetLaunchEnvironment({ PUBLIC: 'C:\\Users\\Public', public: 'C:\\other' }, paths)).toThrow()
    expect(() => osSupersetLaunchEnvironment({ PUBLIC: 'relative\\path' }, paths)).toThrow()
    expect(() => osSupersetLaunchEnvironment({ PUBLIC: 'C:\\safe\nGH_TOKEN=x' }, paths)).toThrow()
  })

  it('never promotes an owned attach settling at or after 15 seconds to an on-time CDP result', () => {
    const owned = { browser: { close() {} }, failure: null }
    expect(classifyCdp(owned, 14_999, 15_000)).toBe('OWNED')
    expect(classifyCdp(owned, 15_000, 15_000)).toBe('DEADLINE')
    expect(classifyCdp(owned, 14_999, 15_000, true)).toBe('PROCESS_EXITED')
    expect(classifyCdp({ browser: null, failure: 'cdp-browser-pid-mismatch' }, 1, 15_000)).toBe('PID_MISMATCH')
  })

  it('preserves an owned on-time attach when the process exits while a peer attach is still pending', async () => {
    let exited = false
    const owned = { browser: { close() {} }, failure: null }
    const settled = await captureSettledAttachment(
      Promise.resolve(owned),
      () => exited,
      () => 14_999
    )
    exited = true
    expect(settled.exitedAtSettle).toBe(false)
    expect(classifyCdp(settled.value, settled.settledAt, 15_000, settled.exitedAtSettle)).toBe('OWNED')
    expect(classifyCdp(settled.value, settled.settledAt, 15_000, exited)).toBe('PROCESS_EXITED')
  })

  it('preserves ownership by 45 seconds when an attach settles at 10 seconds and the child exits at 20', () => {
    const cdp = {
      value: { browser: { close() {} }, failure: null },
      settledAt: 10_000,
      exitedAtSettle: false
    }
    const inspector = {
      value: {
        inspector: { close() {} },
        observation: { profileMatches: true, profileMask: 0, versionMatches: true }
      },
      settledAt: 10_000,
      exitedAtSettle: false
    }
    expect(cdpByDeadline(cdp, null, 'EXITED', 45_000)).toBe('OWNED')
    expect(inspectorByDeadline(inspector, null, 'EXITED', 45_000)).toBe('OWNED_MATCH')
    expect(
      cdpByDeadline(
        {
          value: { browser: null, failure: 'cdp-endpoint-deadline' },
          settledAt: 15_000,
          exitedAtSettle: false
        },
        null,
        'EXITED',
        45_000
      )
    ).toBe('PROCESS_EXITED')
    expect(
      inspectorByDeadline(
        {
          value: { inspector: null, observation: null },
          settledAt: 15_000,
          exitedAtSettle: false
        },
        null,
        'EXITED',
        45_000
      )
    ).toBe('PROCESS_EXITED')
  })

  it('does not rewrite a running-at-45 snapshot when a late attach settles after exit', () => {
    const firstCdp = {
      value: { browser: null, failure: 'cdp-endpoint-deadline' },
      settledAt: 15_000,
      exitedAtSettle: false
    }
    const lateCdp = {
      value: { browser: { close() {} }, failure: null },
      settledAt: 45_001,
      exitedAtSettle: true
    }
    const firstInspector = {
      value: { inspector: null, observation: null },
      settledAt: 15_000,
      exitedAtSettle: false
    }
    const lateInspector = {
      value: {
        inspector: { close() {} },
        observation: { profileMatches: true, profileMask: 0, versionMatches: true }
      },
      settledAt: 45_001,
      exitedAtSettle: true
    }
    expect(cdpByDeadline(firstCdp, lateCdp, 'RUNNING', 45_000)).toBe('DEADLINE')
    expect(inspectorByDeadline(firstInspector, lateInspector, 'RUNNING', 45_000)).toBe('UNAVAILABLE')
    expect(cdpByDeadline({ ...lateCdp, settledAt: 15_001 }, null, 'RUNNING', 15_000)).toBe('DEADLINE')
    expect(inspectorByDeadline({ ...lateInspector, settledAt: 15_001 }, null, 'RUNNING', 15_000)).toBe('UNAVAILABLE')
  })

  it('labels window queries as post-deadline and never queries an already exited or recycled PID', async () => {
    const launch = {
      child: { pid: 101, exitCode: null, signalCode: null },
      latches: { spawnError: false, exited: false }
    }
    let calls = 0
    const query = async () => {
      calls += 1
      return 'NORMAL_TITLE'
    }
    expect(await sampleWindowAfterDeadline(launch, query)).toBe('POST_DEADLINE_NORMAL_TITLE')
    expect(calls).toBe(1)
    expect(await sampleWindowAfterDeadline(launch, async () => 'QUERY_SHELL_MISSING')).toBe(
      'POST_DEADLINE_QUERY_SHELL_MISSING'
    )
    launch.latches.exited = true
    expect(await sampleWindowAfterDeadline(launch, query)).toBe('EXITED_BEFORE_QUERY')
    expect(calls).toBe(1)
    launch.latches.exited = false
    expect(
      await sampleWindowAfterDeadline(launch, async () => {
        launch.latches.exited = true
        return 'NORMAL_TITLE'
      })
    ).toBe('EXITED_DURING_QUERY')
  })

  it('classifies only fixed PowerShell query failure stages without returning error text', async () => {
    const failed = (code: string, killed = false) => async () => {
      throw Object.assign(new Error('PRIVATE_QUERY_FAILURE'), { code, killed })
    }
    const root = 'C:\\Windows'
    expect(await queryWindowStatus(101, failed('ENOENT'), root)).toBe('QUERY_SHELL_MISSING')
    expect(await queryWindowStatus(101, failed('ETIMEDOUT', true), root)).toBe('QUERY_TIMEOUT')
    expect(await queryWindowStatus(101, failed('OTHER'), root)).toBe('QUERY_SHELL_FAILED')
    expect(await queryWindowStatus(101, async () => ({ stdout: 'QUERY_PROCESS_LOOKUP_FAILED\n', stderr: '' }), root)).toBe(
      'QUERY_PROCESS_LOOKUP_FAILED'
    )
    expect(await queryWindowStatus(101, async () => ({ stdout: 'PRIVATE_QUERY_FAILURE', stderr: '' }), root)).toBe(
      'QUERY_OUTPUT_INVALID'
    )
    expect(await queryWindowStatus(101, async () => ({ stdout: 'NORMAL_TITLE\n', stderr: '' }), 'relative')).toBe(
      'QUERY_SHELL_PATH_INVALID'
    )
  })

  it('requires an owned inspector observation and treats deadline or profile mismatch as diagnostic', () => {
    const attached = {
      inspector: { close() {} },
      observation: { profileMatches: true, profileMask: 0, versionMatches: true }
    }
    expect(classifyInspector(attached, 14_999, 15_000)).toBe('OWNED_MATCH')
    expect(classifyInspector(attached, 15_000, 15_000)).toBe('UNAVAILABLE')
    expect(
      classifyInspector(
        {
          ...attached,
          observation: { ...attached.observation, profileMask: 1 }
        },
        1,
        15_000
      )
    ).toBe('UNAVAILABLE')
    expect(
      classifyInspector(
        {
          inspector: null,
          observation: null,
          transportUncertain: true
        },
        1,
        15_000
      )
    ).toBe('TRANSPORT_UNCERTAIN')
  })

  it('accepts only the pinned fixed-enum diagnostic report and never a 2.0 acceptance claim', () => {
    const valid = report()
    expect(reportProblems(valid)).toEqual([])
    expect(reportProblems({ ...valid, original_acceptance: 'PASS' })).not.toEqual([])
    expect(reportProblems({ ...valid, variants: [...valid.variants, variant('STRICT')] })).not.toEqual([])
    expect(
      reportProblems({
        ...valid,
        variants: [variant('STRICT'), { ...variant('OS_SUPERSET'), raw_window_title: 'private' }]
      })
    ).not.toEqual([])
    expect(
      reportProblems({
        ...valid,
        variants: [
          variant('STRICT'),
          {
            ...variant('OS_SUPERSET'),
            transport_release: 'RELEASED',
            teardown: 'UNACKNOWLEDGED'
          }
        ]
      })
    ).not.toEqual([])
    expect(
      reportProblems({
        ...valid,
        identity: { ...valid.identity, installer_sha256: '0'.repeat(64) }
      })
    ).not.toEqual([])
    expect(
      reportProblems({
        ...valid,
        variants: [
          variant('STRICT'),
          { ...variant('OS_SUPERSET'), at_15s: { ...snapshot(), cdp_http_interval: 'PRIVATE_RESPONSE_BODY' } }
        ]
      })
    ).toContain('SNAPSHOT_STATUS')
    expect(
      reportProblems({
        ...valid,
        variants: [
          variant('STRICT'),
          { ...variant('OS_SUPERSET'), at_15s: { ...snapshot(), inspector_attach_stage: 'PRIVATE_SOCKET_URL' } }
        ]
      })
    ).toContain('SNAPSHOT_STATUS')
  })
})
