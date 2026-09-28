import { describe, expect, it } from 'vitest'
import {
  exitCodeForReportResult,
  reportResultForRows,
  runtimeRoleVerdict,
  scenarioEvidence,
  scenarioStillStarting,
  supervisedColdStartVerdict
} from './hk-m.mjs'

const modelSidecar = { pid: 101, ppid: 100, startedMs: 1001, exe: '/tmp/llama-server', role: 'llama-server' }
const renderer = { pid: 102, ppid: 100, startedMs: 1002, exe: '/tmp/Metis Helper', role: 'Metis Helper (Renderer)' }
const ffmpeg = { pid: 103, ppid: 100, startedMs: 1003, exe: '/tmp/ffmpeg', role: 'ffmpeg' }

describe('HK-M scenario evidence', () => {
  it('does not accept an ordinary Electron child as model-starting proof', () => {
    const proof = scenarioEvidence('model-starting', {
      records: [],
      registry: [],
      sidecars: [renderer]
    })

    expect(proof).toMatchObject({
      ok: false,
      status: 'BLOCKED_EXTERNAL',
      failure: 'scenario_not_triggered'
    })
  })

  it('fails model-starting when the audit trigger is present but the model sidecar role is absent', () => {
    const proof = scenarioEvidence('model-starting', {
      records: [{ event: 'sidecar.spawn', name: 'llama-server' }],
      registry: [],
      sidecars: [renderer]
    })

    expect(proof).toMatchObject({
      ok: false,
      status: 'FAIL',
      failure: 'expected_model_sidecar_absent'
    })
  })

  it('accepts model-starting only with local runtime audit evidence and the model sidecar role', () => {
    const proof = scenarioEvidence('model-starting', {
      records: [{ event: 'local.runtime.start' }],
      registry: [],
      sidecars: [renderer, modelSidecar]
    })

    expect(proof).toMatchObject({ ok: true })
  })

  it('requires active-inference, ffmpeg-import, and registry-write scenario markers', () => {
    expect(
      scenarioEvidence('active-inference', {
        records: [{ event: 'local.runtime.start' }],
        registry: [],
        sidecars: [modelSidecar]
      })
    ).toMatchObject({ ok: false, status: 'BLOCKED_EXTERNAL', failure: 'scenario_not_triggered' })

    expect(
      scenarioEvidence('ffmpeg-import', {
        records: [{ event: 'hk-m.ffmpeg-import' }],
        registry: [],
        sidecars: [ffmpeg]
      })
    ).toMatchObject({ ok: true })

    expect(
      scenarioEvidence('registry-write', {
        records: [{ event: 'hk-m.registry-write' }],
        registry: [{ kind: 'intent', name: 'llama-server' }],
        sidecars: [modelSidecar]
      })
    ).toMatchObject({ ok: true })
  })
})

describe('HK-M report result', () => {
  it('is pass only when every live row passes', () => {
    expect(reportResultForRows([{ status: 'PASS' }, { status: 'PASS' }])).toBe('pass')
    expect(exitCodeForReportResult('pass')).toBe(0)
  })

  it('keeps blocked rows non-passing so the CI acceptance lane fails without 20/20 live proof', () => {
    const result = reportResultForRows([{ status: 'PASS' }, { status: 'BLOCKED_EXTERNAL' }])

    expect(result).toBe('blocked')
    expect(exitCodeForReportResult(result)).toBe(1)
  })

  it('fails when any row fails', () => {
    const result = reportResultForRows([{ status: 'PASS' }, { status: 'FAIL' }, { status: 'BLOCKED_EXTERNAL' }])

    expect(result).toBe('fail')
    expect(exitCodeForReportResult(result)).toBe(1)
  })
})

const wrapper = { pid: 100, ppid: 1, startedMs: 1000, exe: '/tmp/metis-mac-helper', role: 'metis-mac-helper' }
const supervisedModel = { pid: 101, ppid: 100, startedMs: 1001, exe: '/tmp/llama-server', role: 'llama-server' }

describe('HK-M relaunch runtime counts', () => {
  it('accepts no runtime when the row started none, and exactly one when it started a model', () => {
    expect(runtimeRoleVerdict([renderer], false)).toMatchObject({ ok: true, counts: {} })
    expect(runtimeRoleVerdict([renderer, modelSidecar], true)).toMatchObject({ ok: true, counts: { 'llama-server': 1 } })
  })

  it('fails a duplicated runtime role even when none was expected', () => {
    const duplicate = { ...modelSidecar, pid: 201 }
    expect(runtimeRoleVerdict([modelSidecar, duplicate], false)).toMatchObject({
      ok: false,
      failure: 'duplicate_runtime_after_relaunch'
    })
    expect(runtimeRoleVerdict([modelSidecar, duplicate], true)).toMatchObject({
      ok: false,
      failure: 'duplicate_runtime_after_relaunch'
    })
  })

  it('fails a model row whose relaunch never brought a runtime back', () => {
    expect(runtimeRoleVerdict([renderer], true)).toMatchObject({ ok: false, failure: 'runtime_missing_after_relaunch' })
  })

  it('fails when two different runtime roles are alive', () => {
    const fm = { pid: 301, ppid: 100, startedMs: 1005, exe: '/tmp/fm', role: 'fm' }
    expect(runtimeRoleVerdict([modelSidecar, fm], true)).toMatchObject({
      ok: false,
      failure: 'multiple_runtime_roles_after_relaunch'
    })
  })
})

describe('HK-M supervised cold start', () => {
  const healthy = [{ event: 'local.runtime.start' }]

  it('passes when llama-server runs under the supervise wrapper without a fallback', () => {
    expect(
      supervisedColdStartVerdict({
        records: healthy,
        sidecars: [wrapper, supervisedModel],
        table: [wrapper, supervisedModel],
        requireHealthy: true
      })
    ).toEqual({ ok: true })
  })

  it('fails a llama-server that was spawned directly by main', () => {
    const main = { pid: 50, ppid: 1, startedMs: 900, exe: '/tmp/Metis', role: 'Metis' }
    const direct = { ...supervisedModel, ppid: 50 }
    expect(
      supervisedColdStartVerdict({ records: healthy, sidecars: [direct], table: [main, direct], requireHealthy: true })
    ).toEqual({ ok: false, failure: 'runtime_not_supervised' })
  })

  it('fails when the audit log records a fallback to direct spawn', () => {
    expect(
      supervisedColdStartVerdict({
        records: [...healthy, { event: 'sidecar.unsupervised' }],
        sidecars: [supervisedModel],
        table: [wrapper, supervisedModel],
        requireHealthy: true
      })
    ).toEqual({ ok: false, failure: 'sidecar_unsupervised_fallback' })
  })

  it('demands health only when asked', () => {
    const input = { records: [], sidecars: [supervisedModel], table: [wrapper, supervisedModel] }
    expect(supervisedColdStartVerdict({ ...input, requireHealthy: false })).toEqual({ ok: true })
    expect(supervisedColdStartVerdict({ ...input, requireHealthy: true })).toEqual({
      ok: false,
      failure: 'supervised_cold_start_unhealthy'
    })
  })
})

describe('HK-M scenario waiting', () => {
  it('keeps waiting for a missing marker or a sidecar that is not visible yet, but not for other failures', () => {
    expect(scenarioStillStarting({ ok: false, status: 'BLOCKED_EXTERNAL', failure: 'scenario_not_triggered' })).toBe(true)
    expect(scenarioStillStarting({ ok: false, status: 'FAIL', failure: 'expected_model_sidecar_absent' })).toBe(true)
    expect(scenarioStillStarting({ ok: false, status: 'FAIL', failure: 'expected_ffmpeg_sidecar_absent' })).toBe(false)
    expect(scenarioStillStarting({ ok: true })).toBe(false)
  })
})
