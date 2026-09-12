import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('electron')
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: mocks.spawn
}))
vi.mock('./managed-node', () => ({
  ensureManagedNode: vi.fn(async () => ({ node: process.execPath, npm: '', source: 'packaged' })),
  resolveManagedNode: vi.fn(() => ({ node: process.execPath, npm: '', source: 'packaged' }))
}))

import { app } from 'electron'
import { installManagedCli, managedCliEntry, prepareManagedPackageForProduction } from './cli-installer'

let root: string
let userData: string
let probe: 'success' | 'wrong-version' | 'nonzero' | 'hang'
let killBehavior: 'close' | 'never'
let lastChild: ReturnType<typeof childFixture>
let installOptions: { cwd?: string; env?: NodeJS.ProcessEnv } | undefined
const version = '0.4.6'

function childFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => {
      if (killBehavior === 'close') queueMicrotask(() => child.emit('close', null))
      return true
    })
  })
  return child
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metis-dust-install-test-'))
  userData = join(root, 'profile')
  probe = 'success'
  killBehavior = 'close'
  installOptions = undefined
  vi.mocked(app.getPath).mockImplementation(() => userData)
  mocks.spawn.mockImplementation((_command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    const child = childFixture()
    lastChild = child
    const checking = args.includes('--version')
    if (!checking) installOptions = options
    queueMicrotask(() => {
      if (!checking) {
        child.emit('close', 0)
      } else if (probe !== 'hang') {
        child.stdout.emit('data', Buffer.from(`Dust CLI v${probe === 'wrong-version' ? '0.4.5' : version}\n`))
        child.emit('close', probe === 'nonzero' ? 1 : 0)
      }
    })
    return child
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  mocks.spawn.mockReset()
  rmSync(root, { recursive: true, force: true })
})

function writePackage(dir: string) {
  mkdirSync(dir, { recursive: true })
  const manifest = {
    name: '@dust-tt/dust-cli', version,
    dependencies: { diff: '^8.0.2', keytar: '^7.9.0' },
    devDependencies: { diff: '^8.0.2', 'ts-node': '^10.9.2' }
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
  return manifest
}

function stageDownload(integrityValid = true) {
  const source = join(root, 'archive-source')
  writePackage(join(source, 'package'))
  mkdirSync(join(source, 'package', 'dist'), { recursive: true })
  writeFileSync(join(source, 'package', 'dist', 'index.js'), 'console.log("Dust CLI v0.4.6")\n')
  const archive = join(root, 'dust.tgz')
  execFileSync('tar', ['-czf', archive, '-C', source, 'package'])
  const bytes = readFileSync(archive)
  const integrity = 'sha512-' + createHash('sha512').update(integrityValid ? bytes : Buffer.from('tampered')).digest('base64')
  vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).includes('/latest')) {
      return new Response(JSON.stringify({ version, dist: { tarball: 'https://example.invalid/dust.tgz', integrity } }))
    }
    return new Response(bytes)
  }))
}

function previousInstall(previousVersion = version) {
  const installRoot = join(userData, 'managed-cli', 'dust')
  const entry = join(installRoot, previousVersion, 'package', 'dist', 'index.js')
  mkdirSync(dirname(entry), { recursive: true })
  writeFileSync(entry, 'previous working entry')
  const pointer = JSON.stringify({ version: previousVersion, entry })
  writeFileSync(join(installRoot, 'current.json'), pointer)
  return { installRoot, entry, pointer }
}

describe('MQA-317 — Dust runtime dependencies and pre-promotion readiness', () => {
  it('removes only dev keys duplicated in runtime dependencies without changing runtime ranges', () => {
    const dir = join(root, 'package')
    const original = writePackage(dir)
    prepareManagedPackageForProduction(dir)
    const normalized = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    expect(normalized.dependencies).toEqual(original.dependencies)
    expect(normalized.devDependencies).toEqual({ 'ts-node': '^10.9.2' })
    expect(normalized.name).toBe(original.name)
    expect(normalized.version).toBe(original.version)
  })

  it('leaves package bytes untouched if there is no duplicate dev dependency', () => {
    const dir = join(root, 'package')
    mkdirSync(dir)
    const original = '{"dependencies":{"diff":"^8.0.2"},"devDependencies":{"ts-node":"^10.9.2"}}\n'
    writeFileSync(join(dir, 'package.json'), original)
    prepareManagedPackageForProduction(dir)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(original)
  })

  it('normalizes only after SRI verification, uses --omit=dev, and promotes only after the real entry version check', async () => {
    vi.stubEnv('DUST_API_KEY', 'synthetic-do-not-inherit')
    vi.stubEnv('DUST_WORKSPACE_ID', 'synthetic-do-not-inherit')
    stageDownload()
    const phases: string[] = []
    const installed = await installManagedCli('dust', (p) => phases.push(p.phase))
    expect(phases.at(-1)).toBe('done')
    expect(managedCliEntry('dust')).toEqual(installed)
    const normalized = JSON.parse(readFileSync(join(dirname(dirname(installed.entry)), 'package.json'), 'utf8'))
    expect(normalized.dependencies.diff).toBe('^8.0.2')
    expect(normalized.devDependencies).toEqual({ 'ts-node': '^10.9.2' })
    const npmCall = mocks.spawn.mock.calls.find(([, args]) => args.includes('install'))
    expect(npmCall?.[1]).toContain('--omit=dev')
    const readinessCall = mocks.spawn.mock.calls.find(([, args]) => args.includes('--version'))
    expect(readinessCall?.[0]).toBe(process.execPath)
    expect(readinessCall?.[1]).toEqual([expect.stringContaining('.tmp-'), '--version'])
    const env = readinessCall?.[2].env as NodeJS.ProcessEnv
    expect(env.HOME).not.toBe(process.env.HOME)
    expect(env.HOME).not.toBe(userData)
    expect(env.XDG_CONFIG_HOME).toContain(env.HOME)
    expect(env.DUST_API_KEY).toBeUndefined()
    expect(env.DUST_WORKSPACE_ID).toBeUndefined()
    expect(existsSync(env.HOME!)).toBe(false)
    expect(installOptions?.cwd).toContain('.tmp-')
  })

  it('does not normalize, install dependencies, or run a readiness process when SRI is invalid', async () => {
    stageDownload(false)
    await expect(installManagedCli('dust', () => {})).rejects.toThrow(/integrity/i)
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(existsSync(join(userData, 'managed-cli', 'dust'))).toBe(false)
  })

  it.each(['wrong-version', 'nonzero'] as const)('preserves an existing same-version installation on %s readiness failure', async (failure) => {
    stageDownload()
    const previous = previousInstall()
    probe = failure
    await expect(installManagedCli('dust', () => {})).rejects.toThrow(/startup check/i)
    expect(readFileSync(previous.entry, 'utf8')).toBe('previous working entry')
    expect(readFileSync(join(previous.installRoot, 'current.json'), 'utf8')).toBe(previous.pointer)
    expect(readdirSync(previous.installRoot).sort()).toEqual([version, 'current.json'].sort())
  })

  it('rejects a hanging readiness check at 30 seconds, kills it, and preserves the previous same-version install', async () => {
    stageDownload()
    const previous = previousInstall()
    vi.useFakeTimers()
    probe = 'hang'
    const result = installManagedCli('dust', () => {}).then(
      () => ({ error: null }),
      (error: Error) => ({ error })
    )
    await vi.waitFor(() => expect(mocks.spawn.mock.calls.some(([, args]) => args.includes('--version'))).toBe(true))
    await vi.advanceTimersByTimeAsync(30_000)
    expect((await result).error?.message).toMatch(/startup check.*timed out/i)
    expect(lastChild.kill).toHaveBeenCalledWith('SIGTERM')
    expect(readFileSync(previous.entry, 'utf8')).toBe('previous working entry')
    expect(readFileSync(join(previous.installRoot, 'current.json'), 'utf8')).toBe(previous.pointer)
    expect(readdirSync(previous.installRoot).sort()).toEqual([version, 'current.json'].sort())
  })

  it('cancels readiness without replacing the prior pointer and removes staging data', async () => {
    stageDownload()
    const previous = previousInstall('0.4.5')
    probe = 'hang'
    const controller = new AbortController()
    const result = installManagedCli('dust', () => {}, controller.signal).then(
      () => ({ error: null }),
      (error: Error) => ({ error })
    )
    await vi.waitFor(() => expect(mocks.spawn.mock.calls.some(([, args]) => args.includes('--version'))).toBe(true))
    controller.abort()
    expect((await result).error?.message).toBe('cancelled')
    expect(lastChild.kill).toHaveBeenCalledWith('SIGTERM')
    expect(readFileSync(previous.entry, 'utf8')).toBe('previous working entry')
    expect(readFileSync(join(previous.installRoot, 'current.json'), 'utf8')).toBe(previous.pointer)
    expect(readdirSync(previous.installRoot).sort()).toEqual(['0.4.5', 'current.json'].sort())
  })

  it('waits for the killed child to close before settling cancellation or deleting its staged files', async () => {
    stageDownload()
    const previous = previousInstall()
    probe = 'hang'
    killBehavior = 'never'
    const controller = new AbortController()
    let settled = false
    const result = installManagedCli('dust', () => {}, controller.signal).then(
      () => ({ error: null }), (error: Error) => ({ error })
    ).finally(() => { settled = true })
    await vi.waitFor(() => expect(mocks.spawn.mock.calls.some(([, args]) => args.includes('--version'))).toBe(true))
    const readinessCall = mocks.spawn.mock.calls.find(([, args]) => args.includes('--version'))!
    controller.abort()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(lastChild.kill).toHaveBeenCalledWith('SIGTERM')
    expect(settled).toBe(false)
    expect(existsSync(readinessCall[1][0])).toBe(true)
    expect(existsSync(readinessCall[2].env.HOME)).toBe(true)
    expect(readFileSync(previous.entry, 'utf8')).toBe('previous working entry')
    lastChild.emit('close', null)
    expect((await result).error?.message).toBe('cancelled')
    expect(existsSync(readinessCall[1][0])).toBe(false)
    expect(existsSync(readinessCall[2].env.HOME)).toBe(false)
    expect(readFileSync(join(previous.installRoot, 'current.json'), 'utf8')).toBe(previous.pointer)
  })

  it('rejects oversized stdout before decoding and ignores further bytes while terminating or settled', async () => {
    stageDownload()
    const previous = previousInstall()
    probe = 'hang'
    killBehavior = 'never'
    const result = installManagedCli('dust', () => {}).then(
      () => ({ error: null }), (error: Error) => ({ error })
    )
    await vi.waitFor(() => expect(mocks.spawn.mock.calls.some(([, args]) => args.includes('--version'))).toBe(true))
    const child = lastChild
    const oversized = Buffer.alloc(1025, 'x')
    const decodeOversized = vi.spyOn(oversized, 'toString')
    const late = Buffer.from('late noisy output')
    const decodeLate = vi.spyOn(late, 'toString')
    try {
      child.stdout.emit('data', oversized)
      expect(decodeOversized).not.toHaveBeenCalled()
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      child.stdout.emit('data', late)
      expect(decodeLate).not.toHaveBeenCalled()
      child.emit('close', null)
      expect((await result).error?.message).toMatch(/unexpected output/)
      child.stdout.emit('data', late)
      expect(decodeLate).not.toHaveBeenCalled()
      expect(readFileSync(previous.entry, 'utf8')).toBe('previous working entry')
    } finally {
      child.emit('close', null)
      await result
    }
  })

  it('escalates a stuck child, bounds cancellation, and defers locked-tree cleanup until exit is confirmed', async () => {
    stageDownload()
    const previous = previousInstall()
    vi.useFakeTimers()
    probe = 'hang'
    killBehavior = 'never'
    const controller = new AbortController()
    const result = installManagedCli('dust', () => {}, controller.signal).then(
      () => ({ error: null }), (error: Error) => ({ error })
    )
    await vi.waitFor(() => expect(mocks.spawn.mock.calls.some(([, args]) => args.includes('--version'))).toBe(true))
    const readinessCall = mocks.spawn.mock.calls.find(([, args]) => args.includes('--version'))!
    controller.abort()
    await vi.advanceTimersByTimeAsync(1000)
    expect(lastChild.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(1000)
    expect((await result).error?.message).toBe('cancelled')
    expect(existsSync(readinessCall[1][0])).toBe(true)
    expect(existsSync(readinessCall[2].env.HOME)).toBe(true)
    expect(readFileSync(join(previous.installRoot, 'current.json'), 'utf8')).toBe(previous.pointer)
    lastChild.emit('close', null)
    expect(existsSync(readinessCall[1][0])).toBe(false)
    expect(existsSync(readinessCall[2].env.HOME)).toBe(false)
    expect(readFileSync(previous.entry, 'utf8')).toBe('previous working entry')
  })
})
