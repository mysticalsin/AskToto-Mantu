import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtureReceipt, runHostedFixture } from '../qa/lib/st-1-termination.integration.mjs'

const boundaries = vi.hoisted(() => ({ spawn: vi.fn(), stop: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: boundaries.spawn }))
vi.mock('../qa/lib/st-1-termination.mjs', () => ({ stopOwnedChild: boundaries.stop }))

const root = join(__dirname, '..', '..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n')
const source = read('scripts/qa/lib/st-1-termination.integration.mjs')
const workflow = read('.github/workflows/build.yml')
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
if (!originalPlatform) throw new Error('process.platform descriptor is required')

function mockPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value })
}

function admitHosted(): void {
  mockPlatform('linux')
  vi.stubEnv('GITHUB_ACTIONS', 'true')
  vi.stubEnv('RUNNER_ENVIRONMENT', 'github-hosted')
  vi.stubEnv('METIS_FIXTURE_RUNNER_ENVIRONMENT', 'github-hosted')
}

function ownedFixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: process.pid + 1,
    exitCode: null as number | null,
    signalCode: null as string | null,
    connected: true,
    send: vi.fn()
  })
  const descendantPid = process.pid + 2
  child.send.mockImplementation((message: { kind: string; nonce: string }) => {
    queueMicrotask(() => {
      child.emit('message', { kind: 'ready', nonce: message.nonce, rootPid: child.pid, descendantPid })
    })
  })
  boundaries.spawn.mockReturnValue(child)
  return { child, descendantPid }
}

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  boundaries.spawn.mockReset()
  boundaries.stop.mockReset()
})

describe('hosted owned-termination fixture admission and privacy', () => {
  it.each([
    ['', 'github-hosted', 'github-hosted'],
    ['true', 'self-hosted', 'github-hosted'],
    ['true', 'github-hosted', 'self-hosted'],
    ['true', '', ''],
    ['TRUE', 'github-hosted', 'github-hosted']
  ])('refuses non-hosted admission before any process operation (%s, %s, %s)', async (actions, runner, context) => {
    vi.stubEnv('GITHUB_ACTIONS', actions)
    vi.stubEnv('RUNNER_ENVIRONMENT', runner)
    vi.stubEnv('METIS_FIXTURE_RUNNER_ENVIRONMENT', context)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const receipt = await runHostedFixture()

    expect(receipt).toMatchObject({ verdict: 'FAIL', reason: 'host-admission', cleanup: 'not-needed' })
    expect(boundaries.spawn).not.toHaveBeenCalled()
    expect(boundaries.stop).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    expect(Object.keys(receipt).sort()).toEqual(['cleanup', 'durationMs', 'platform', 'reason', 'schema', 'verdict'])
  })

  it('refuses unsupported platforms before spawning even on an admitted hosted route', async () => {
    admitHosted()
    mockPlatform('unsupported')
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    await expect(runHostedFixture()).resolves.toMatchObject({
      verdict: 'FAIL',
      reason: 'unsupported-platform',
      platform: 'unsupported',
      cleanup: 'not-needed'
    })
    expect(boundaries.spawn).not.toHaveBeenCalled()
    expect(boundaries.stop).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })

  it('does not disclose an arbitrary spawn error or invoke termination after a failed spawn', async () => {
    admitHosted()
    boundaries.spawn.mockImplementation(() => {
      throw new Error('private path /owner/profile nonce=secret pid=1234')
    })
    const receipt = await runHostedFixture()

    expect(receipt).toMatchObject({ verdict: 'FAIL', reason: 'spawn-failed', cleanup: 'not-needed' })
    expect(boundaries.spawn).toHaveBeenCalledTimes(1)
    expect(boundaries.stop).not.toHaveBeenCalled()
    expect(JSON.stringify(receipt)).not.toMatch(/private|owner|secret|1234/)
  })

  it('requires authenticated readiness, real liveness probes and one helper ACK before PASS', async () => {
    admitHosted()
    const { child, descendantPid } = ownedFixture()
    const signal = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === descendantPid && child.exitCode != null) {
        throw Object.assign(new Error('private process path'), { code: 'ESRCH' })
      }
      return true
    })
    boundaries.stop.mockImplementation(async () => {
      child.exitCode = 0
      child.connected = false
      return { state: 'acknowledged' }
    })

    await expect(runHostedFixture()).resolves.toMatchObject({ verdict: 'PASS', reason: 'ok', cleanup: 'not-needed' })
    expect(boundaries.stop.mock.calls).toEqual([[child]])
    expect(signal.mock.calls).toContainEqual([child.pid, 0])
    expect(signal.mock.calls).toContainEqual([descendantPid, 0])
    expect(signal.mock.calls.every((call) => call[1] === 0)).toBe(true)
    expect(child.eventNames()).toEqual([])
  })

  it('rejects a mismatched readiness nonce without invoking the helper or leaking payloads', async () => {
    admitHosted()
    const { child, descendantPid } = ownedFixture()
    child.send.mockImplementation(() => {
      child.connected = false
      queueMicrotask(() => {
        child.emit('message', { kind: 'ready', nonce: 'private nonce', rootPid: child.pid, descendantPid })
      })
    })
    const receipt = await runHostedFixture()

    expect(receipt).toMatchObject({ verdict: 'FAIL', reason: 'invalid-readiness', cleanup: 'unacknowledged' })
    expect(boundaries.stop).not.toHaveBeenCalled()
    expect(JSON.stringify(receipt)).not.toContain('private nonce')
    expect(child.eventNames()).toEqual([])
  })

  it('does not convert an unacknowledged helper result into success after the root exits', async () => {
    admitHosted()
    const { child } = ownedFixture()
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    boundaries.stop.mockImplementation(async () => {
      child.exitCode = 0
      child.connected = false
      return { state: 'unacknowledged', reason: 'private error' }
    })

    await expect(runHostedFixture()).resolves.toMatchObject({
      verdict: 'FAIL',
      reason: 'helper-unacknowledged',
      cleanup: 'unacknowledged'
    })
    expect(boundaries.stop).toHaveBeenCalledTimes(1)
    expect(child.eventNames()).toEqual([])
  })

  it('refuses an already exited root before invoking the helper', async () => {
    admitHosted()
    const { child } = ownedFixture()
    child.exitCode = 0
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => true)

    await expect(runHostedFixture()).resolves.toMatchObject({
      verdict: 'FAIL',
      reason: 'root-not-live',
      cleanup: 'unacknowledged'
    })
    expect(boundaries.stop).not.toHaveBeenCalled()
    expect(signal).not.toHaveBeenCalled()
    expect(child.eventNames()).toEqual([])
  })

  it('rechecks the deadline after liveness probes and before the helper call', async () => {
    admitHosted()
    const { child, descendantPid } = ownedFixture()
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const signal = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === -child.pid) {
        clock = 5_000
        child.connected = false
      }
      return true
    })

    await expect(runHostedFixture()).resolves.toMatchObject({
      verdict: 'FAIL',
      reason: 'readiness-timeout',
      cleanup: 'unacknowledged'
    })
    expect(signal.mock.calls).toEqual([
      [child.pid, 0],
      [descendantPid, 0],
      [-child.pid, 0]
    ])
    expect(boundaries.stop).not.toHaveBeenCalled()
    expect(child.eventNames()).toEqual([])
  })

  it.each(['root-equal', 'owner-equal', 'unsafe', 'fractional', 'wrong-root'])(
    'rejects %s readiness identity without probing or invoking the helper',
    async (variant) => {
      admitHosted()
      const { child, descendantPid } = ownedFixture()
      child.send.mockImplementation((message: { nonce: string }) => {
        const ready = { kind: 'ready', nonce: message.nonce, rootPid: child.pid, descendantPid }
        if (variant === 'root-equal') ready.descendantPid = child.pid
        if (variant === 'owner-equal') ready.descendantPid = process.pid
        if (variant === 'unsafe') ready.descendantPid = 1
        if (variant === 'fractional') ready.descendantPid = descendantPid + 0.5
        if (variant === 'wrong-root') ready.rootPid = descendantPid
        child.connected = false
        queueMicrotask(() => child.emit('message', ready))
      })
      const signal = vi.spyOn(process, 'kill').mockImplementation(() => true)
      const receipt = await runHostedFixture()

      expect(receipt).toMatchObject({ verdict: 'FAIL', reason: 'invalid-readiness', cleanup: 'unacknowledged' })
      expect(boundaries.stop).not.toHaveBeenCalled()
      expect(signal).not.toHaveBeenCalled()
      expect(Object.keys(receipt).sort()).toEqual(['cleanup', 'durationMs', 'platform', 'reason', 'schema', 'verdict'])
      expect(child.eventNames()).toEqual([])
    }
  )

  it.each(['missing', 'extra'])('rejects a readiness response with a %s own field', async (variant) => {
    admitHosted()
    const { child, descendantPid } = ownedFixture()
    child.send.mockImplementation((message: { nonce: string }) => {
      const ready: Record<string, unknown> = {
        kind: 'ready',
        nonce: message.nonce,
        rootPid: child.pid,
        descendantPid
      }
      if (variant === 'missing') delete ready.descendantPid
      else ready.privateField = 'private readiness payload'
      child.connected = false
      queueMicrotask(() => child.emit('message', ready))
    })
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const receipt = await runHostedFixture()

    expect(receipt).toMatchObject({ verdict: 'FAIL', reason: 'invalid-readiness', cleanup: 'unacknowledged' })
    expect(boundaries.stop).not.toHaveBeenCalled()
    expect(signal).not.toHaveBeenCalled()
    expect(Object.keys(receipt).sort()).toEqual(['cleanup', 'durationMs', 'platform', 'reason', 'schema', 'verdict'])
    expect(JSON.stringify(receipt)).not.toMatch(/privateField|private readiness payload/)
    expect(child.eventNames()).toEqual([])
  })

  it('refuses readiness delivered at the deadline without starting the helper', async () => {
    admitHosted()
    const { child, descendantPid } = ownedFixture()
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    child.send.mockImplementation((message: { nonce: string }) => {
      child.connected = false
      queueMicrotask(() => {
        clock = 5_000
        child.emit('message', { kind: 'ready', nonce: message.nonce, rootPid: child.pid, descendantPid })
      })
    })
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const receipt = await runHostedFixture()

    expect(receipt).toMatchObject({ verdict: 'FAIL', reason: 'readiness-timeout', cleanup: 'unacknowledged' })
    expect(boundaries.stop).not.toHaveBeenCalled()
    expect(signal).not.toHaveBeenCalled()
    expect(Object.keys(receipt).sort()).toEqual(['cleanup', 'durationMs', 'platform', 'reason', 'schema', 'verdict'])
    expect(child.eventNames()).toEqual([])
  })

  it('serializes only closed labels, finite bounded duration and a supported platform', () => {
    expect(fixtureReceipt('private secret', 'private path', Infinity, 'private cleanup')).toEqual({
      schema: 'st1-owned-termination-v1',
      verdict: 'FAIL',
      reason: 'unexpected',
      platform: 'unsupported',
      durationMs: 20_000,
      cleanup: 'unacknowledged'
    })
    expect(fixtureReceipt('ok', 'linux', -1, 'not-needed')).toMatchObject({
      verdict: 'PASS',
      reason: 'ok',
      durationMs: 0
    })
    expect(fixtureReceipt('ok', 'linux', 1, 'unacknowledged')).toMatchObject({ verdict: 'FAIL', reason: 'unexpected' })
    expect(fixtureReceipt('ok', 'private platform', 1, 'not-needed')).toMatchObject({ verdict: 'FAIL' })
  })
})

describe('dedicated disposable hosted fixture job', () => {
  const lines = workflow.split('\n')
  const start = lines.indexOf('  owned-termination:')
  const end = lines.findIndex((line, index) => index > start && /^ {2}[A-Za-z0-9_-]+:/.test(line))
  const job = lines.slice(start, end === -1 ? undefined : end).join('\n')

  it('isolates one real invocation on each fresh Linux/Windows hosted runner', () => {
    expect(start).toBeGreaterThan(-1)
    expect(lines.filter((line) => line === '  owned-termination:')).toHaveLength(1)
    expect(job).toContain('runs-on: ${{ matrix.os }}')
    expect(job).toContain('os: [ubuntu-latest, windows-latest]')
    expect(job).toContain('timeout-minutes: 5')
    expect(job).toContain('contents: read')
    expect(job).toContain('persist-credentials: false')
    expect(job).toContain('actions/checkout@11d5960a326750d5838078e36cf38b85af677262')
    expect(job).toContain('METIS_FIXTURE_RUNNER_ENVIRONMENT: ${{ runner.environment }}')
    expect(job).toContain('        timeout-minutes: 1')
    expect(job.match(/^ {8}run: .+$/gm)).toEqual(['        run: node scripts/qa/lib/st-1-termination.integration.mjs'])
    expect(job.match(/^ {6}- /gm)).toHaveLength(3)
    expect(job).not.toMatch(/continue-on-error:|\bif:|\bneeds:|\bsecrets\b|\bcache:|upload-artifact|download-artifact/)
    expect(job.trim().endsWith('run: node scripts/qa/lib/st-1-termination.integration.mjs')).toBe(true)
  })

  it('keeps real fixture execution outside ordinary tests and calls the actual helper only once', () => {
    expect(read('vitest.config.ts')).toContain("'scripts/**/*.{test,spec}.{ts,tsx}'")
    expect(source).toContain('pathToFileURL(process.argv[1]).href === import.meta.url')
    expect(source.match(/await stopOwnedChild\(child\)/g)).toHaveLength(1)
    expect(source).not.toMatch(/execSync|execFile|spawnSync|console\.|\.kill\([^,]+,\s*['"]SIG/)
    expect(source).toContain("stdio: ['ignore', 'ignore', 'ignore', 'ipc']")
  })
})
