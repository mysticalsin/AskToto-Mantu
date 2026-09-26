import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixtures = vi.hoisted(() => ({
  audit: '',
  onSpawn: undefined as (() => void) | undefined,
  child: undefined as unknown,
  spawn: vi.fn(),
  remove: vi.fn(),
  execFileSync: vi.fn()
}))
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => {
    fixtures.spawn(...args)
    fixtures.onSpawn?.()
    return fixtures.child
  },
  execFileSync: (...args: unknown[]) => fixtures.execFileSync(...args)
}))
vi.mock('node:fs', () => ({
  existsSync: () => true,
  mkdtempSync: () => '/fixture/mac-launch-profile',
  readFileSync: () => fixtures.audit,
  readdirSync: () => [],
  rmSync: fixtures.remove,
  writeFileSync: vi.fn()
}))

class GateExit extends Error {
  constructor(readonly code: number) { super(`gate exited ${code}`) }
}
class FakeChild extends EventEmitter {
  pid = 1729
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  unref = vi.fn()
  // Only read on the Windows path (child.stdout/stderr.on), harmless and unused on the macOS path.
  stdout = new EventEmitter()
  stderr = new EventEmitter()
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
  fixtures.execFileSync.mockReset()
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
})

describe('Windows signing design F18: the launched app never sees release-job signing credentials', () => {
  // The gate is a top-level script (every code path ends in process.exit), so scrubLaunchEnv cannot be
  // imported and called in isolation without also running the whole launch flow — this exercises it
  // exactly the way the real Windows release build does: end-to-end, through the actual spawn call.
  it('the Windows launch path spawns the app with AZURE_ / WIN_AZURE_ / WIN_CSC_ / *_API_KEY vars removed', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.argv = [process.execPath, 'check-packaged-launch.mjs', '/fixture/Metis.exe']
    vi.stubEnv('AZURE_CLIENT_ID', 'client-id-leak')
    vi.stubEnv('AZURE_TENANT_ID', 'tenant-id-leak')
    vi.stubEnv('WIN_CSC_LINK', 'pfx-cert-leak')
    vi.stubEnv('WIN_CSC_KEY_PASSWORD', 'pfx-password-leak')
    vi.stubEnv('WIN_AZURE_PUBLISHER_NAME', 'publisher-leak')
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-leak')
    fixtures.execFileSync.mockImplementation((_cmd: string, args: string[]) =>
      args.join(' ').includes('MainWindowTitle') ? 'Metis\n' : ''
    )

    expect(await runGate()).toBe(0)

    expect(fixtures.spawn).toHaveBeenCalledOnce()
    const spawnedEnv = fixtures.spawn.mock.calls[0][2].env as Record<string, string>
    for (const leaked of [
      'AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD',
      'WIN_AZURE_PUBLISHER_NAME', 'OPENAI_API_KEY'
    ]) {
      expect(spawnedEnv, leaked).not.toHaveProperty(leaked)
    }
    expect(spawnedEnv.ELECTRON_ENABLE_LOGGING).toBe('1')
  })
})
