import { describe, it, expect, afterAll, afterEach, vi } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { promisify } from 'node:util'
import { importDustCliSession } from './dustcli'
import { clearDustSessionSecretsCache } from './dust-secret-store'

const exec = promisify(execFile)

// Real keychain round-trip — exercises the exact `security find-generic-password` path the app uses,
// but against a THROWAWAY service so the user's real `dust login` session is never touched.
const TEST_SERVICE = 'asktoto-dustcli-test'
const ACCOUNTS = ['access_token', 'workspace_sid', 'region']

// Probe once whether this environment can actually write the login keychain. Sandboxes and headless CI
// deny `security add-generic-password`, where this real-keychain suite would FAIL rather than prove
// anything — so skip cleanly there instead of reporting a false failure.
function keychainWritable(): boolean {
  if (process.platform !== 'darwin') return false
  const probe = 'asktoto-dustcli-probe'
  try {
    execFileSync('security', ['add-generic-password', '-s', probe, '-a', 'probe', '-w', 'x'], { stdio: 'ignore' })
    try {
      execFileSync('security', ['delete-generic-password', '-s', probe, '-a', 'probe'], { stdio: 'ignore' })
    } catch {
      /* best-effort cleanup */
    }
    return true
  } catch {
    return false
  }
}
const canKeychain = keychainWritable()

async function delItem(account: string): Promise<void> {
  // Delete every duplicate (security keeps only one per service+account, but loop to be safe).
  for (let i = 0; i < 5; i++) {
    try {
      await exec('security', ['delete-generic-password', '-s', TEST_SERVICE, '-a', account])
    } catch {
      return // none left
    }
  }
}
async function delAll(): Promise<void> {
  for (const a of ACCOUNTS) await delItem(a)
}
async function setSession(fields: Record<string, string>): Promise<void> {
  await delAll()
  for (const [account, value] of Object.entries(fields)) {
    await exec('security', ['add-generic-password', '-s', TEST_SERVICE, '-a', account, '-w', value])
  }
}

describe.runIf(canKeychain)('importDustCliSession (real keychain)', () => {
  afterAll(async () => {
    await delAll()
    clearDustSessionSecretsCache(TEST_SERVICE)
  })
  afterEach(() => {
    clearDustSessionSecretsCache(TEST_SERVICE)
  })

  it('reports no session when the keychain is empty', async () => {
    await delAll()
    const r = await importDustCliSession(TEST_SERVICE)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/No Dust CLI session found/i)
  })

  it('imports token + workspace and maps EU region to eu.dust.tt', async () => {
    await setSession({ access_token: 'tok_eu_123', workspace_sid: 'ws_eu', region: 'europe-west1' })
    const r = await importDustCliSession(TEST_SERVICE)
    expect(r.ok).toBe(true)
    expect(r.token).toBe('tok_eu_123')
    expect(r.workspaceId).toBe('ws_eu')
    expect(r.baseUrl).toBe('https://eu.dust.tt')
  })

  it('maps US region to dust.tt', async () => {
    await setSession({ access_token: 'tok_us_123', workspace_sid: 'ws_us', region: 'us-central1' })
    const r = await importDustCliSession(TEST_SERVICE)
    expect(r.ok).toBe(true)
    expect(r.baseUrl).toBe('https://dust.tt')
  })

  it('fails when only a partial session exists (token but no workspace)', async () => {
    await setSession({ access_token: 'tok_only' })
    const r = await importDustCliSession(TEST_SERVICE)
    expect(r.ok).toBe(false)
  })

  // `dust login` is a two-step flow: browser OAuth writes access_token first, then a separate
  // interactive terminal workspace-picker writes workspace_sid. A user who closes the terminal after
  // the browser step leaves exactly this state — access_token present, workspace_sid missing — which
  // must be distinguishable from "no session at all" so the UI doesn't relaunch the whole setup.
  it('flags a token-but-no-workspace session as incomplete, not a bare failure', async () => {
    await setSession({ access_token: 'tok_only' })
    const r = await importDustCliSession(TEST_SERVICE)
    expect(r.ok).toBe(false)
    expect(r.incomplete).toBe(true)
  })

  it('does not flag a genuinely empty keychain as incomplete', async () => {
    await delAll()
    const r = await importDustCliSession(TEST_SERVICE)
    expect(r.ok).toBe(false)
    expect(r.incomplete).toBeFalsy()
  })
})

// ─── MQA-019 — `dust status` timeout must reap the whole process tree ──────────────────────────
// Deliberately doMock (not the hoisted vi.mock) so the real-keychain suite above — which resolved its
// `./dustcli` and `node:child_process` bindings at file load — keeps shelling out for real.

const REAL_PLATFORM = process.platform

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
  const spawnImpl = vi.fn()
  const execFileImpl = vi.fn()
  const actualCp = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  vi.doMock('node:child_process', () => ({ ...actualCp, spawn: spawnImpl, execFile: execFileImpl }))
  vi.doMock('electron', () => ({ app: { getPath: (): string => '/tmp' }, shell: { openPath: vi.fn() } }))
  vi.doMock('./dust-secret-store', () => ({
    DUST_KEYCHAIN_SERVICE: 'dust-cli',
    peekDustSessionSecretsCache: (): null => null,
    clearDustSessionSecretsCache: (): void => {},
    readDustSecret: async (): Promise<{ value: null; accessDenied: boolean }> => ({ value: null, accessDenied: false }),
    readDustSessionSecrets: async () => ({
      access_token: { value: null, accessDenied: false },
      workspace_sid: { value: null, accessDenied: false },
      region: { value: null, accessDenied: false },
      privilegeSpawns: 1
    })
  }))
  vi.doMock('./cli', async () => {
    const actualCli = await vi.importActual<typeof import('./cli')>('./cli')
    return {
      ...actualCli,
      resolveBin: async (): Promise<string> => bin,
      resolveDustBin: async (): Promise<string> => bin
    }
  })
  const mod = await import('./dustcli')
  return { refreshDustCliSession: mod.refreshDustCliSession, spawnImpl, execFileImpl }
}

/** The refresh's own hard timeout (dustcli.ts STATUS_TIMEOUT_MS). */
const STATUS_TIMEOUT_MS = 25_000

describe('MQA-019 — refreshDustCliSession timeout kills the whole `dust status` tree', () => {
  afterEach(() => {
    vi.useRealTimers()
    setPlatform(REAL_PLATFORM)
    vi.doUnmock('node:child_process')
    vi.doUnmock('electron')
    vi.doUnmock('./dust-secret-store')
    vi.doUnmock('./cli')
    vi.resetModules()
  })

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
