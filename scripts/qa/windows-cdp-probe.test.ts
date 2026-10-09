import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CANDIDATE_RUN,
  INSTALLER_SHA256,
  classifyCdp,
  classifyInspector,
  probeReportProblems,
  runDiagnosticSession
} from './windows-cdp-probe.mjs'

const child = { pid: 1234, exitCode: null, signalCode: null }
const launch = {
  child,
  latches: { spawnError: false, exited: false },
  cdpEndpoint: 'http://127.0.0.1:50001',
  inspectPort: 50002
}
const identity = {
  candidate_run: CANDIDATE_RUN,
  installer_sha256: INSTALLER_SHA256,
  producer_commit: '2d4ebe7b6698f78abcb74dc426867d95d96e4268',
  harness_commit: 'b'.repeat(40),
  version: '1.9.7'
}

describe('Windows CDP diagnostic spike', () => {
  it('does not start inspector work while the original 15-second CDP attempt is pending', async () => {
    let firstStartedResolve = () => {}
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedResolve = () => resolve()
    })
    let releaseFirst = () => {}
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = () => resolve()
    })
    let time = 0
    let inspectorStarted = false
    let observerCancelled = false
    const session = runDiagnosticSession({
      launch,
      expectedPaths: { root: 'C:\\isolated', userData: 'C:\\isolated\\userdata' },
      expectedVersion: '1.9.7',
      now: () => time,
      attachCdp: async () => {
        firstStartedResolve()
        await firstGate
        time = 15_000
        return { browser: null, failure: 'cdp-endpoint-deadline', transportUncertain: true, lateRelease: null }
      },
      attachInspector: async () => {
        inspectorStarted = true
        return { inspector: null, observation: null, transportUncertain: false, lateRelease: null }
      },
      observeProtocols: () => ({
        cancel: () => {
          observerCancelled = true
        }
      }),
      stop: async () => ({ state: 'acknowledged' }),
      normalize: (value: unknown) => value,
      dispose: async () => true
    })
    await firstStarted
    await Promise.resolve()
    const startedBeforeCdpSettled = inspectorStarted
    const observerCancelledBeforeCdpSettled = observerCancelled
    releaseFirst()
    await session
    expect(startedBeforeCdpSettled).toBe(false)
    expect(observerCancelledBeforeCdpSettled).toBe(false)
    expect(observerCancelled).toBe(true)
    expect(inspectorStarted).toBe(true)
  })

  it('never promotes an owned CDP attachment after the 15-second boundary into acceptance', async () => {
    let time = 0
    const calls: Array<{ timeoutMs: number; deadlineMs: number }> = []
    const teardownOrder: string[] = []
    const browser = { close: async () => true }
    const result = await runDiagnosticSession({
      launch,
      expectedPaths: { root: 'C:\\isolated', userData: 'C:\\isolated\\userdata' },
      expectedVersion: '1.9.7',
      now: () => time,
      attachCdp: async ({ timeoutMs, deadlineMs }: { timeoutMs: number; deadlineMs: number }) => {
        calls.push({ timeoutMs, deadlineMs })
        time = calls.length === 1 ? 15_000 : 22_000
        return calls.length === 1
          ? { browser: null, failure: 'cdp-endpoint-deadline', transportUncertain: false, lateRelease: null }
          : { browser, failure: null, transportUncertain: false, lateRelease: null }
      },
      attachInspector: async () => ({
        inspector: { close: async () => true },
        observation: { profileMatches: true, profileMask: 0, versionMatches: true, nativeFullDisplay: false },
        transportUncertain: false,
        lateRelease: null
      }),
      observeProtocols: () => null,
      stop: async () => {
        teardownOrder.push('stop-owned-child')
        return { state: 'acknowledged' }
      },
      normalize: (value: unknown) => value,
      dispose: async () => {
        teardownOrder.push('release-transports')
        return true
      }
    })
    expect(calls).toEqual([
      { timeoutMs: 15_000, deadlineMs: 15_000 },
      { timeoutMs: 30_000, deadlineMs: 45_000 }
    ])
    expect(result.acceptance_15s).toBe('DEADLINE')
    expect(result.cdp_45s).toBe('OWNED_CDP')
    expect(result.inspector_45s).toBe('OWNED_PROFILE_AND_VERSION')
    expect(result.teardown).toBe('ACKNOWLEDGED')
    expect(teardownOrder).toEqual(['stop-owned-child', 'release-transports'])
  })

  it('keeps an exited owned child from being classified as a 15-second acceptance', async () => {
    let inspectorCalls = 0
    const result = await runDiagnosticSession({
      launch: { ...launch, latches: { spawnError: false, exited: true } },
      expectedPaths: { root: 'C:\\isolated', userData: 'C:\\isolated\\userdata' },
      expectedVersion: '1.9.7',
      attachCdp: async () => ({
        browser: { close: async () => true },
        failure: null,
        transportUncertain: false,
        lateRelease: null
      }),
      attachInspector: async () => {
        inspectorCalls++
        return { inspector: null, observation: null, transportUncertain: false, lateRelease: null }
      },
      observeProtocols: () => null,
      stop: async () => ({ state: 'acknowledged' }),
      normalize: (value: unknown) => value,
      dispose: async () => true
    })
    expect(result.acceptance_15s).toBe('PROCESS_EXITED')
    expect(result.cdp_45s).toBe('NOT_RUN')
    expect(result.process_at_end).toBe('EXITED')
    expect(inspectorCalls).toBe(0)
    expect(result.teardown).toBe('ACKNOWLEDGED')
  })

  it('never retries a transport-uncertain or PID-mismatched attachment', async () => {
    for (const failure of ['cdp-transport-timeout', 'cdp-browser-pid-mismatch']) {
      let calls = 0
      const result = await runDiagnosticSession({
        launch,
        expectedPaths: { root: 'C:\\isolated', userData: 'C:\\isolated\\userdata' },
        expectedVersion: '1.9.7',
        now: () => 0,
        attachCdp: async () => {
          calls++
          return { browser: null, failure, transportUncertain: failure === 'cdp-transport-timeout', lateRelease: null }
        },
        attachInspector: async () => ({
          inspector: null,
          observation: null,
          transportUncertain: false,
          lateRelease: null
        }),
        observeProtocols: () => null,
        stop: async () => ({ state: 'acknowledged' }),
        normalize: (value: unknown) => value,
        dispose: async () => true
      })
      expect(calls).toBe(1)
      expect(result.acceptance_15s).toBe(classifyCdp({ failure }))
      expect(result.cdp_45s).toBe('NOT_RUN')
    }
  })

  it('does not release transports or claim completion without an owned-child stop receipt', async () => {
    let disposed = false
    const result = await runDiagnosticSession({
      launch,
      expectedPaths: { root: 'C:\\isolated', userData: 'C:\\isolated\\userdata' },
      expectedVersion: '1.9.7',
      now: () => 0,
      attachCdp: async () => ({
        browser: null,
        failure: 'cdp-browser-pid-mismatch',
        transportUncertain: false,
        lateRelease: null
      }),
      attachInspector: async () => ({
        inspector: null,
        observation: null,
        transportUncertain: false,
        lateRelease: null
      }),
      observeProtocols: () => null,
      stop: async () => ({ state: 'unacknowledged', reason: 'root-exit-unobserved' }),
      normalize: (value: unknown) => value,
      dispose: async () => {
        disposed = true
        return true
      }
    })
    expect(disposed).toBe(false)
    expect(result.teardown).toBe('UNACKNOWLEDGED')
    expect(result.transport_release).toBe('UNCERTAIN')
  })

  it('reports inspector ownership only when the fixed profile and version observation agrees', () => {
    expect(
      classifyInspector({
        inspector: { close: async () => true },
        observation: { profileMatches: true, profileMask: 0, versionMatches: true, nativeFullDisplay: false }
      })
    ).toBe('OWNED_PROFILE_AND_VERSION')
    expect(
      classifyInspector({
        inspector: { close: async () => true },
        observation: { profileMatches: false, profileMask: 1, versionMatches: true, nativeFullDisplay: false }
      })
    ).toBe('OWNED_PROFILE_MISMATCH')
    expect(classifyInspector({ inspector: null, observation: null })).toBe('UNAVAILABLE')
  })

  it('rejects arbitrary content and refuses to treat a late observation as an accepted result', () => {
    const report = {
      schema: 'metis.windows-cdp-diagnostic-spike.v1',
      diagnostic_only: true,
      identity,
      acceptance_15s: 'DEADLINE',
      cdp_45s: 'OWNED_CDP',
      inspector_45s: 'OWNED_PROFILE_AND_VERSION',
      process_at_end: 'RUNNING',
      teardown: 'ACKNOWLEDGED',
      transport_release: 'RELEASED'
    }
    expect(probeReportProblems(report)).toEqual([])
    expect(probeReportProblems({ ...report, raw_url: 'http://127.0.0.1:50001' })).not.toEqual([])
    expect(probeReportProblems({ ...report, acceptance_15s: 'OWNED_CDP', cdp_45s: 'OWNED_CDP' })).not.toEqual([])
    expect(probeReportProblems({ ...report, inspector_45s: 'C:\\users\\runner' })).not.toEqual([])
  })

  it('keeps the hosted workflow pinned, main-only, finite and diagnostic-only', () => {
    const workflow = readFileSync(join(process.cwd(), '.github/workflows/windows-cdp-diagnostic-spike.yml'), 'utf8')
    expect(workflow).toContain("github.ref == 'refs/heads/main'")
    expect(workflow).toContain('gh run download 37771807736')
    expect(workflow).toContain(INSTALLER_SHA256)
    expect(workflow).toContain('2d4ebe7b6698f78abcb74dc426867d95d96e4268')
    expect(workflow).toContain('Metis-Setup-1.9.7.exe')
    expect(workflow).toContain('candidate-scenarios.mjs guard candidate-run.json 37771807736')
    expect(workflow).toContain('timeout-minutes: 3')
    expect(workflow).toContain('retention-days: 7')
    expect(workflow).not.toContain('actions/create-release')
    expect(workflow).not.toContain('contents: write')
  })
})
