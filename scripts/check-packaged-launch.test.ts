import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildLaunchReport } from './launch-report.mjs'

const fixtures = vi.hoisted(() => ({
  audit: '',
  onSpawn: undefined as (() => void) | undefined,
  child: undefined as unknown,
  spawn: vi.fn(),
  remove: vi.fn(),
  write: vi.fn()
}))
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => {
    fixtures.spawn(...args)
    fixtures.onSpawn?.()
    return fixtures.child
  },
  execFileSync: vi.fn()
}))
vi.mock('node:fs', () => ({
  existsSync: () => true,
  mkdtempSync: () => '/fixture/mac-launch-profile',
  readFileSync: () => fixtures.audit,
  readdirSync: () => [],
  rmSync: fixtures.remove,
  writeFileSync: fixtures.write
}))

class GateExit extends Error {
  constructor(readonly code: number) { super(`gate exited ${code}`) }
}
class FakeChild extends EventEmitter {
  pid = 1729
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  unref = vi.fn()
  constructor() {
    super()
    // Keep deliberately injected errors observable without an uncaught EventEmitter error in the
    // pre-fix implementation, which did not attach a spawn-error listener at all.
    this.on('error', () => {})
  }
}
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const argv = process.argv
let child: FakeChild

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(0)
  fixtures.audit = ''
  fixtures.onSpawn = undefined
  fixtures.spawn.mockClear()
  fixtures.remove.mockClear()
  fixtures.write.mockClear()
  child = new FakeChild()
  fixtures.child = child
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  process.argv = [process.execPath, 'check-packaged-launch.mjs', '/fixture/Metis.app', '--timeout-seconds', '6']
  vi.stubEnv('ASKTOTO_MAC_LAUNCH_GATE', '1')
  vi.spyOn(process, 'exit').mockImplementation((code) => { throw new GateExit(Number(code ?? 0)) })
  vi.spyOn(process, 'kill').mockReturnValue(true)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  // The old gate blocked the event loop. Advance its clock without blocking this regression test.
  vi.spyOn(Atomics, 'wait').mockImplementation((_array, _index, _value, timeout) => {
    vi.advanceTimersByTime(Number(timeout ?? 0))
    return 'timed-out'
  })
})
afterEach(() => {
  process.argv = argv
  Object.defineProperty(process, 'platform', platform)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function event(name: string): string { return JSON.stringify({ event: name }) + '\n' }
async function runGate(): Promise<number> {
  const result = import('./check-packaged-launch.mjs').then(
    () => { throw new Error('The launch gate did not report an exit status') },
    (error: unknown) => {
      if (!(error instanceof GateExit)) throw error
      return error.code
    }
  )
  await vi.waitFor(() => expect(fixtures.spawn).toHaveBeenCalledOnce())
  await vi.runAllTimersAsync()
  return result
}

describe('MQA-318 packaged Mac launch readiness', () => {
  it('does not accept app.started without a renderer-ready signal', async () => {
    fixtures.audit = event('app.started')
    expect(await runGate()).toBe(1)
  })

  it('requires three seconds of survival after actual renderer readiness', async () => {
    fixtures.onSpawn = () => setTimeout(() => { fixtures.audit = event('app.renderer.ready') }, 500)
    expect(await runGate()).toBe(0)
    expect(Date.now()).toBeGreaterThanOrEqual(3500)
    expect(Atomics.wait).not.toHaveBeenCalled()
    expect(fixtures.remove).toHaveBeenCalledWith('/fixture/mac-launch-profile', { recursive: true, force: true })
  })

  it('fails if the main process exits before readiness', async () => {
    fixtures.onSpawn = () => setTimeout(() => child.emit('exit', 1, null), 100)
    expect(await runGate()).toBe(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/exited/i))
    expect(Date.now()).toBeLessThan(6000)
  })

  it('fails if the main process exits during the survival interval', async () => {
    fixtures.audit = event('app.started') + event('app.renderer.ready')
    fixtures.onSpawn = () => setTimeout(() => child.emit('exit', 0, null), 1000)
    expect(await runGate()).toBe(1)
  })

  it('also rejects an observed exit status before its exit event is delivered', async () => {
    fixtures.audit = event('app.renderer.ready')
    fixtures.onSpawn = () => setTimeout(() => { child.exitCode = 1 }, 1000)
    expect(await runGate()).toBe(1)
  })

  it('fails on a spawn error rather than waiting for a misleading ready signal', async () => {
    fixtures.audit = event('app.started')
    fixtures.onSpawn = () => setTimeout(() => child.emit('error', new Error('spawn ENOENT')), 100)
    expect(await runGate()).toBe(1)
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/spawn ENOENT/))
  })

  it.each(['app.crash', 'app.unresponsive'])('fails on %s after readiness', async (name) => {
    fixtures.audit = event('app.started') + event('app.renderer.ready')
    fixtures.onSpawn = () => setTimeout(() => { fixtures.audit += event(name) }, 1000)
    expect(await runGate()).toBe(1)
  })

  // Invariant: the gate must launch the executable named after the bundle it was given, never a hardcoded name.
  it('launches the executable named after the bundle it was given, not a hardcoded name', async () => {
    process.argv = [process.execPath, 'check-packaged-launch.mjs', '/fixture/Metis QA.app', '--timeout-seconds', '6']
    fixtures.onSpawn = () => setTimeout(() => { fixtures.audit = event('app.renderer.ready') }, 500)
    expect(await runGate()).toBe(0)
    expect(fixtures.spawn).toHaveBeenCalledWith(
      join('/fixture/Metis QA.app', 'Contents', 'MacOS', 'Metis QA'),
      [],
      expect.objectContaining({ stdio: 'ignore', detached: true })
    )
  })
})

const SHA = 'ab'.repeat(32)
const reportArgs = ['--report', '/runner/work/report.json', '--installer', 'Metis-1.9.7.zip', '--artifact-sha256', SHA, '--candidate-run', '4242', '--signature', 'ad-hoc']
function writtenReport(): Record<string, unknown> {
  expect(fixtures.write).toHaveBeenCalledOnce()
  const [path, body] = fixtures.write.mock.calls[0] as [string, string]
  expect(path).toBe('/runner/work/report.json')
  return JSON.parse(body)
}

describe('M2-0508 launch report', () => {
  it('writes nothing without --report', async () => {
    fixtures.onSpawn = () => setTimeout(() => { fixtures.audit = event('app.renderer.ready') }, 500)
    expect(await runGate()).toBe(0)
    expect(fixtures.write).not.toHaveBeenCalled()
  })

  it('writes a content-free PASS report for a healthy launch', async () => {
    process.argv = [...process.argv, ...reportArgs]
    fixtures.onSpawn = () => setTimeout(() => { fixtures.audit = event('app.renderer.ready') }, 500)
    expect(await runGate()).toBe(0)
    expect(writtenReport()).toEqual({
      installer: 'Metis-1.9.7.zip',
      artifact_sha256: SHA,
      candidate_run: 4242,
      signature: 'ad-hoc',
      platform: 'darwin',
      verdict: 'PASS',
      product_window_observed: true,
      error_dialog_seen: null,
      elapsed_ms: expect.any(Number)
    })
  })

  it('writes a FAIL report and still exits 1 when the app dies before readiness', async () => {
    process.argv = [...process.argv, ...reportArgs]
    fixtures.onSpawn = () => setTimeout(() => child.emit('exit', 1, null), 100)
    expect(await runGate()).toBe(1)
    expect(writtenReport()).toMatchObject({ verdict: 'FAIL', product_window_observed: false })
  })

  it('fails the gate rather than write a report with a malformed sha256', async () => {
    process.argv = [...process.argv, '--report', '/runner/work/report.json', '--artifact-sha256', 'not-a-hash']
    fixtures.onSpawn = () => setTimeout(() => { fixtures.audit = event('app.renderer.ready') }, 500)
    expect(await runGate()).toBe(1)
    expect(fixtures.write).not.toHaveBeenCalled()
  })
})

describe('M2-0508 report builder', () => {
  const base = {
    installer: 'Metis-1.9.7.zip',
    artifactSha256: SHA,
    candidateRun: '4242',
    signature: 'NotSigned',
    platform: 'win32',
    verdict: 'PASS',
    productWindowObserved: true,
    errorDialogSeen: false,
    elapsedMs: 1200
  }

  it.each(['', 'ABCD', 'AB'.repeat(32), 'zz'.repeat(32), `${SHA}0`])('rejects the malformed sha256 %j', (sha) => {
    expect(() => buildLaunchReport({ ...base, artifactSha256: sha } as never)).toThrow(/sha256/)
  })

  it.each([
    ['/Users/someone/work/Metis-1.9.7.zip'],
    ['C:\\Users\\someone\\AppData\\Local\\Temp\\Metis-1.9.7.zip'],
    ['assets/Metis-1.9.7.zip']
  ])('keeps only the file name of %s', (installer) => {
    const report = buildLaunchReport({ ...base, installer } as never)
    expect(report.installer).toBe('Metis-1.9.7.zip')
    expect(JSON.stringify(report)).not.toMatch(/Users|AppData|assets\/|\\\\/)
  })

  it('rejects an installer with no file name, a bad run id and a free-text signature', () => {
    expect(() => buildLaunchReport({ ...base, installer: '/' } as never)).toThrow(/installer/)
    expect(() => buildLaunchReport({ ...base, candidateRun: '-3' } as never)).toThrow(/candidate run/)
    expect(() => buildLaunchReport({ ...base, signature: 'C:\\Users\\x signed' } as never)).toThrow(/signature/)
  })
})
