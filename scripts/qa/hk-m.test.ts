import { describe, expect, it } from 'vitest'
import { scenarioEvidence } from './hk-m.mjs'

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
