import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { importDustCliSession } from './dustcli'

// Every process boundary is intercepted before imports or test collection. Changing HOME does not
// isolate the macOS login Keychain, so even a capability probe must never reach the host.
const osBoundary = vi.hoisted(() => ({
  unexpected: vi.fn(() => {
    throw new Error('Unexpected process invocation in Dust CLI fixture')
  }),
  execFile: vi.fn(),
  spawn: vi.fn(),
  execFileAsync: vi.fn<(command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>>()
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  return {
    ...actual,
    exec: osBoundary.unexpected,
    execSync: osBoundary.unexpected,
    execFile: Object.assign(osBoundary.execFile, { [promisify.custom]: osBoundary.execFileAsync }),
    execFileSync: osBoundary.unexpected,
    spawn: osBoundary.spawn,
    spawnSync: osBoundary.unexpected,
    fork: osBoundary.unexpected
  }
})
vi.mock('electron', () => ({
  app: { getPath: (): string => process.env.ASKTOTO_USERDATA! },
  shell: { openPath: vi.fn() }
}))

// Exercise importDustCliSession AND the real readDustSecret adapter, stopping at execFile.
// These are command/decoding contracts, not installed Keychain acceptance.
const TEST_SERVICE = 'asktoto-dustcli-test'
const ACCOUNTS = ['access_token', 'workspace_sid', 'region']
const REAL_PLATFORM = process.platform
const fields = new Map<string, string>()

const collectionProcessCalls = [
  osBoundary.unexpected,
  osBoundary.execFileAsync,
  osBoundary.execFile,
  osBoundary.spawn
].reduce((count, fn) => count + fn.mock.calls.length, 0)
it('does not invoke a process while collecting the Dust CLI tests', () => {
  expect(collectionProcessCalls).toBe(0)
})

function setSession(values: Record<string, string>): void {
  fields.clear()
  for (const [account, value] of Object.entries(values)) fields.set(account, value)
}

afterEach(() => {
  vi.useRealTimers()
  setPlatform(REAL_PLATFORM)
  vi.doUnmock('./dust-secret-store')
  vi.doUnmock('./cli')
  vi.resetModules()
  expect(osBoundary.unexpected).not.toHaveBeenCalled()
})

describe('importDustCliSession (mocked macOS process boundary)', () => {
  beforeEach(() => {
    setPlatform('darwin')
    fields.clear()
    osBoundary.execFile.mockReset()
    osBoundary.spawn.mockReset()
    osBoundary.execFileAsync.mockReset().mockImplementation(async (_command, args) => {
      const value = fields.get(args[4])
      if (value === undefined) {
        throw Object.assign(new Error('Item not found'), {
          stderr: 'The specified item could not be found in the keychain.'
        })
      }
      return { stdout: `${value}\n`, stderr: '' }
    })
  })

  afterEach(() => {
    expect(osBoundary.execFile).not.toHaveBeenCalled()
    expect(osBoundary.spawn).not.toHaveBeenCalled()
    // Assert outside the mock: production deliberately catches a failed OS read, so an assertion
    // thrown inside execFile would otherwise be swallowed as a missing credential.
    for (const [command, args] of osBoundary.execFileAsync.mock.calls) {
      expect(command).toBe('security')
      expect(ACCOUNTS).toContain(args[4])
      expect(args).toEqual(['find-generic-password', '-s', TEST_SERVICE, '-a', args[4], '-w'])
    }
  })

  it('reports no session when the keychain is empty', async () => {
    const r = await importDustCliSession(TEST_SERVICE)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/No Dust CLI session found/i)
    expect(osBoundary.execFileAsync).toHaveBeenCalledTimes(1)
  })

  it('imports token + workspace and maps EU region to eu.dust.tt', async () => {
    setSession({ access_token: 'tok_eu_123', workspace_sid: 'ws_eu', region: 'europe-west1' })
    const r = await importDustCliSession(TEST_SERVICE)
    expect(r.ok).toBe(true)
    expect(r.token).toBe('tok_eu_123')
    expect(r.workspaceId).toBe('ws_eu')
    expect(r.baseUrl).toBe('https://eu.dust.tt')
    expect(osBoundary.execFileAsync.mock.calls.map(([, args]) => args[4])).toEqual(ACCOUNTS)
  })

  it('maps US region to dust.tt', async () => {
    setSession({ access_token: 'tok_us_123', workspace_sid: 'ws_us', region: 'us-central1' })
    const r = await importDustCliSession(TEST_SERVICE)
    expect(r.ok).toBe(true)
    expect(r.baseUrl).toBe('https://dust.tt')
  })

  it('fails when only a partial session exists (token but no workspace)', async () => {
    setSession({ access_token: 'tok_only' })
    const r = await importDustCliSession(TEST_SERVICE)
    expect(r.ok).toBe(false)
  })

  // `dust login` is a two-step flow: browser OAuth writes access_token first, then a separate
  // interactive terminal workspace-picker writes workspace_sid. A user who closes the terminal after
  // the browser step leaves exactly this state — access_token present, workspace_sid missing — which
  // must be distinguishable from "no session at all" so the UI doesn't relaunch the whole setup.
  it('flags a token-but-no-workspace session as incomplete, not a bare failure', async () => {
    setSession({ access_token: 'tok_only' })
    const r = await importDustCliSession(TEST_SERVICE)
    expect(r.ok).toBe(false)
    expect(r.incomplete).toBe(true)
  })

  it('does not flag a genuinely empty keychain as incomplete', async () => {
    const r = await importDustCliSession(TEST_SERVICE)
    expect(r.ok).toBe(false)
    expect(r.incomplete).toBeFalsy()
  })

  it('trims command output and uses the US host when the region is absent', async () => {
    setSession({ access_token: '  fixture-token  ', workspace_sid: '  fixture-workspace  ' })
    expect(await importDustCliSession(TEST_SERVICE)).toEqual({
      ok: true,
      token: 'fixture-token',
      workspaceId: 'fixture-workspace',
      baseUrl: 'https://dust.tt'
    })
  })

  it.each(
    ACCOUNTS
  )('stops at a denied %s read without reporting an incomplete session or leaking a token', async (account) => {
    setSession({ access_token: 'fixture-token', workspace_sid: 'fixture-workspace', region: 'europe-west1' })
    const read = osBoundary.execFileAsync.getMockImplementation()!
    osBoundary.execFileAsync.mockImplementation(async (command, args) => {
      if (args[4] === account) {
        throw Object.assign(new Error('Read denied'), { stderr: 'User interaction is not allowed.' })
      }
      return read(command, args)
    })
    const r = await importDustCliSession(TEST_SERVICE)
    expect(r.ok).toBe(false)
    expect(r.accessDenied).toBe(true)
    expect(r.incomplete).toBeUndefined()
    expect(r.token).toBeUndefined()
    expect(r.error).toMatch(/Keychain/)
    expect(osBoundary.execFileAsync.mock.calls.map(([, args]) => args[4])).toEqual(
      ACCOUNTS.slice(0, ACCOUNTS.indexOf(account) + 1)
    )
  })
})

// ─── MQA-019 — `dust status` timeout must reap the whole process tree ──────────────────────────
// Fresh module state and mocked secret reads keep the timeout cases independent of the import cases.

/** process.platform is configurable in Node — flip it for the duration of a Windows-path test. */
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

/** Stand-in for the spawned child: refreshDustCliSession only ever touches pid/on/kill. */
function fakeChild(pid: number): EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> } {
  return Object.assign(new EventEmitter(), { pid, kill: vi.fn() })
}

/** Load a fresh `./dustcli` (module-level single-flight state must not leak between tests) with
 *  `dust` resolved to `bin` and spawn/execFile observable. resolveSpawnTarget stays REAL — the whole
 *  point is that a `.cmd` bin puts cmd.exe between us and the process holding the refresh token. */
async function loadDustCli(bin: string): Promise<{
  refreshDustCliSession: () => Promise<unknown>
  spawnImpl: ReturnType<typeof vi.fn>
  execFileImpl: ReturnType<typeof vi.fn>
}> {
  vi.resetModules()
  const spawnImpl = osBoundary.spawn.mockReset()
  const execFileImpl = osBoundary.execFile.mockReset()
  vi.doMock('./dust-secret-store', () => ({
    DUST_KEYCHAIN_SERVICE: 'dust-cli',
    readDustSecret: async (): Promise<{ value: null; accessDenied: boolean }> => ({ value: null, accessDenied: false })
  }))
  vi.doMock('./cli', async () => {
    const actualCli = await vi.importActual<typeof import('./cli')>('./cli')
    return { ...actualCli, resolveBin: async (): Promise<string> => bin }
  })
  const mod = await import('./dustcli')
  return { refreshDustCliSession: mod.refreshDustCliSession, spawnImpl, execFileImpl }
}

/** The refresh's own hard timeout (dustcli.ts STATUS_TIMEOUT_MS). */
const STATUS_TIMEOUT_MS = 25_000

describe('MQA-019 — refreshDustCliSession timeout kills the whole `dust status` tree', () => {
  // MQA-019: on Windows `dust` resolves to `dust.cmd`, so the child is cmd.exe and the real
  // `node …dust-cli status` — the process actually holding the single-use OAuth refresh token — is a
  // grandchild. Killing only cmd.exe (execFile's built-in `timeout`, or a bare child.kill) leaves that
  // grandchild running past the single-flight guard, so the next refresh rotates the same token
  // concurrently and invalidates the whole CLI session.
  it('taskkills the tree by pid, not just cmd.exe, when the CLI hangs on Windows', async () => {
    setPlatform('win32')
    const { refreshDustCliSession, spawnImpl, execFileImpl } = await loadDustCli(
      'C:\\Users\\tony\\AppData\\Roaming\\npm\\dust.cmd'
    )
    const child = fakeChild(4242)
    spawnImpl.mockReturnValue(child)
    vi.useFakeTimers()

    const pending = refreshDustCliSession()
    await vi.advanceTimersByTimeAsync(1) // let resolveBin settle so the spawn + timer exist
    expect(spawnImpl).toHaveBeenCalledTimes(1)
    expect(String(spawnImpl.mock.calls[0]![0])).toMatch(/cmd\.exe$/i) // the shim path, i.e. a grandchild

    await vi.advanceTimersByTimeAsync(STATUS_TIMEOUT_MS) // CLI never exits — the timeout fires
    const taskkill = execFileImpl.mock.calls.find((c) => /taskkill\.exe$/i.test(String(c[0])))
    expect(taskkill, 'timeout must taskkill the tree, not orphan the grandchild').toBeTruthy()
    expect(taskkill![1]).toEqual(['/pid', '4242', '/T', '/F'])
    await pending
  })

  // MQA-019: off Windows there is no shim indirection — the child IS dust — so the behaviour that was
  // already correct must stay: a plain SIGTERM, and no taskkill (it does not exist there).
  it('signals the child directly on macOS instead of shelling out to taskkill', async () => {
    setPlatform('darwin')
    const { refreshDustCliSession, spawnImpl, execFileImpl } = await loadDustCli('/usr/local/bin/dust')
    const child = fakeChild(777)
    spawnImpl.mockReturnValue(child)
    vi.useFakeTimers()

    const pending = refreshDustCliSession()
    await vi.advanceTimersByTimeAsync(1)
    expect(spawnImpl.mock.calls[0]![0]).toBe('/usr/local/bin/dust')

    await vi.advanceTimersByTimeAsync(STATUS_TIMEOUT_MS)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(execFileImpl.mock.calls.some((c) => /taskkill/i.test(String(c[0])))).toBe(false)
    await pending
  })

  // MQA-019 guard: the timer must be cleared when the CLI exits normally, otherwise a later tick would
  // taskkill a pid the OS has since recycled onto an unrelated process.
  it('does not kill anything when `dust status` exits before the timeout', async () => {
    setPlatform('win32')
    const { refreshDustCliSession, spawnImpl, execFileImpl } = await loadDustCli(
      'C:\\Users\\tony\\AppData\\Roaming\\npm\\dust.cmd'
    )
    const child = fakeChild(4242)
    spawnImpl.mockReturnValue(child)
    vi.useFakeTimers()

    const pending = refreshDustCliSession()
    await vi.advanceTimersByTimeAsync(1)
    child.emit('close', 0)
    await pending

    await vi.advanceTimersByTimeAsync(STATUS_TIMEOUT_MS)
    expect(execFileImpl.mock.calls.some((c) => /taskkill/i.test(String(c[0])))).toBe(false)
  })
})
