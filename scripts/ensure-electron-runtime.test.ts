import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const EXPECTED = '43.6.0'
const HOST_PLATFORM = 'darwin'
const HOST_ARCH = 'x64'
const NODE = '/fixture/node'
const scratch: string[] = []
const externalPathLinkCases: Array<[string, boolean]> = process.platform === 'win32'
  ? [['existing junction', true]]
  : [['dangling file symlink', false], ['existing file symlink', true]]

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function rootFixture(wrapperVersion = EXPECTED): {
  root: string
  electronDir: string
  installer: string
  runtime: string
} {
  const root = mkdtempSync(join(tmpdir(), 'metis-electron-runtime-'))
  scratch.push(root)
  const electronDir = join(root, 'node_modules', 'electron')
  mkdirSync(electronDir, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    devDependencies: { electron: EXPECTED }
  }))
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
    name: 'asktoto',
    lockfileVersion: 3,
    packages: {
      '': { devDependencies: { electron: EXPECTED } },
      'node_modules/electron': { version: EXPECTED }
    }
  }))
  // Complete published Electron 43.6.0 package shape relevant to this boundary.
  writeFileSync(join(electronDir, 'package.json'), JSON.stringify({
    name: 'electron',
    version: wrapperVersion,
    repository: 'https://github.com/electron/electron',
    description: 'Build cross platform desktop apps with JavaScript, HTML, and CSS',
    license: 'MIT',
    author: 'Electron Community',
    keywords: ['electron'],
    main: 'index.js',
    types: 'electron.d.ts',
    bin: { electron: 'cli.js', 'install-electron': 'install.js' },
    files: ['LICENSE', 'README.md', 'abi_version', 'checksums.json', 'cli.js', 'electron.d.ts', 'index.js', 'install.js'],
    engines: { node: '>= 22.12.0' },
    dependencies: {
      '@electron-internal/extract-zip': '^1.0.1',
      '@electron/get': '^5.0.0',
      '@types/node': '^24.9.0'
    }
  }))
  const installer = join(electronDir, 'install.js')
  writeFileSync(installer, '// official Electron package installer fixture\n')
  const runtime = join(electronDir, 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  return { root, electronDir, installer, runtime }
}

function writeRuntime(fixture: ReturnType<typeof rootFixture>): void {
  mkdirSync(dirname(fixture.runtime), { recursive: true })
  writeFileSync(join(fixture.electronDir, 'path.txt'), 'Electron.app/Contents/MacOS/Electron')
  writeFileSync(fixture.runtime, 'fixture')
}

function healthyProbe() {
  return { status: 0, signal: null, stdout: JSON.stringify({ electron: EXPECTED, platform: HOST_PLATFORM, arch: HOST_ARCH }), stderr: '' }
}

function options(root: string, run: ReturnType<typeof vi.fn>, extra: Record<string, unknown> = {}) {
  return {
    root,
    args: [],
    env: { SENTINEL: 'kept' },
    hostPlatform: HOST_PLATFORM,
    hostArch: HOST_ARCH,
    nodePath: NODE,
    run,
    ...extra
  }
}

async function loadHelper() {
  return import('./ensure-electron-runtime.mjs')
}

describe('ensureElectronRuntime', () => {
  it('accepts only a package-local runtime that reports the locked Electron version and host tuple', async () => {
    const fixture = rootFixture()
    writeRuntime(fixture)
    const run = vi.fn(() => healthyProbe())
    const { ensureElectronRuntime } = await loadHelper()

    await expect(ensureElectronRuntime(options(fixture.root, run, {
      env: {
        SENTINEL: 'kept',
        NODE_OPTIONS: '--require=/tmp/injected.js',
        NODE_PATH: '/tmp/injected-modules',
        NODE_EXTRA_CA_CERTS: '/enterprise/ca.pem',
        HTTPS_PROXY: 'https://proxy.example'
      }
    }))).resolves.toEqual({
      version: EXPECTED,
      executable: fixture.runtime,
      installed: false
    })
    expect(run).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith(
      fixture.runtime,
      ['-p', 'JSON.stringify({electron:process.versions.electron,platform:process.platform,arch:process.arch})'],
      expect.objectContaining({
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 1_048_576,
        killSignal: 'SIGKILL',
        env: {
          SENTINEL: 'kept',
          NODE_EXTRA_CA_CERTS: '/enterprise/ca.pem',
          HTTPS_PROXY: 'https://proxy.example',
          ELECTRON_RUN_AS_NODE: '1'
        }
      })
    )
  })

  it('uses the pinned package install.js only when the runtime is missing, then verifies the installed binary', async () => {
    const fixture = rootFixture()
    const run = vi.fn((command: string, args: string[], invocation: { env: Record<string, string>; timeout: number; maxBuffer: number; killSignal: string }) => {
      if (command === NODE) {
        expect(args).toEqual([realpathSync(fixture.installer)])
        expect(invocation.timeout).toBe(600_000)
        expect(invocation.maxBuffer).toBe(1_048_576)
        expect(invocation.killSignal).toBe('SIGKILL')
        expect(invocation.env).toMatchObject({
          SENTINEL: 'kept',
          ELECTRON_INSTALL_PLATFORM: HOST_PLATFORM,
          ELECTRON_INSTALL_ARCH: HOST_ARCH,
          npm_config_platform: HOST_PLATFORM,
          npm_config_arch: HOST_ARCH
        })
        writeRuntime(fixture)
        return { status: 0, signal: null, stdout: null, stderr: null }
      }
      expect(command).toBe(fixture.runtime)
      return healthyProbe()
    })
    const { ensureElectronRuntime } = await loadHelper()

    await expect(ensureElectronRuntime(options(fixture.root, run))).resolves.toEqual({
      version: EXPECTED,
      executable: fixture.runtime,
      installed: true
    })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['check-only argument', { args: ['--check-only'], env: { SENTINEL: 'kept' } }],
    ['offline argument', { args: ['--offline'], env: { SENTINEL: 'kept' } }],
    ['npm offline mode', {
      args: [],
      env: { SENTINEL: 'kept', npm_config_offline: '', NPM_CONFIG_OFFLINE: 'true' }
    }]
  ])('does not invoke the installer for a missing runtime in %s', async (_label, extra) => {
    const fixture = rootFixture()
    const run = vi.fn()
    const { ensureElectronRuntime } = await loadHelper()

    await expect(ensureElectronRuntime(options(fixture.root, run, extra))).rejects.toThrow(/missing.*verification-only/i)
    expect(run).not.toHaveBeenCalled()
  })

  it('fails before execution when the installed npm wrapper does not match the locked version', async () => {
    const fixture = rootFixture('43.5.1')
    const run = vi.fn()
    const { ensureElectronRuntime } = await loadHelper()

    await expect(ensureElectronRuntime(options(fixture.root, run))).rejects.toThrow(
      'Electron npm package version mismatch: locked 43.6.0, installed 43.5.1.'
    )
    expect(run).not.toHaveBeenCalled()
  })

  it.each([
    ['root lock pin', '43.5.1', EXPECTED],
    ['resolved package', EXPECTED, '43.5.1']
  ])('fails before execution when the lockfile %s disagrees with package.json', async (_label, rootLock, resolved) => {
    const fixture = rootFixture()
    writeFileSync(join(fixture.root, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { devDependencies: { electron: rootLock } },
        'node_modules/electron': { version: resolved }
      }
    }))
    const run = vi.fn()
    const { ensureElectronRuntime } = await loadHelper()

    await expect(ensureElectronRuntime(options(fixture.root, run))).rejects.toThrow(
      `Electron lockfile mismatch: package.json ${EXPECTED}, root lock pin ${rootLock}, resolved ${resolved}.`
    )
    expect(run).not.toHaveBeenCalled()
  })

  it.each([
    ['a nonempty mixed-case alias shadowed by an empty canonical key', {
      ELECTRON_EXEC_PATH: '',
      electron_exec_path: '/tmp/unreviewed-electron'
    }],
    ['a whitespace-only value', { ELECTRON_EXEC_PATH: ' ' }]
  ])('rejects ELECTRON_EXEC_PATH with %s because electron-vite could bypass the verified package runtime', async (_label, env) => {
    const fixture = rootFixture()
    writeRuntime(fixture)
    const run = vi.fn()
    const { ensureElectronRuntime } = await loadHelper()

    await expect(ensureElectronRuntime(options(fixture.root, run, {
      env
    }))).rejects.toThrow('Unset ELECTRON_EXEC_PATH; electron-vite would bypass the verified package runtime.')
    expect(run).not.toHaveBeenCalled()
  })

  it.each([
    ['version', { electron: '40.10.3', platform: HOST_PLATFORM, arch: HOST_ARCH }, '40.10.3/darwin/x64'],
    ['platform', { electron: EXPECTED, platform: 'win32', arch: HOST_ARCH }, '43.6.0/win32/x64'],
    ['architecture', { electron: EXPECTED, platform: HOST_PLATFORM, arch: 'arm64' }, '43.6.0/darwin/arm64']
  ])('fails closed without reinstalling when an existing binary reports a different %s', async (_label, reported, display) => {
    const fixture = rootFixture()
    writeRuntime(fixture)
    const run = vi.fn(() => ({
      status: 0,
      signal: null,
      stdout: JSON.stringify(reported),
      stderr: ''
    }))
    const { ensureElectronRuntime } = await loadHelper()

    await expect(ensureElectronRuntime(options(fixture.root, run))).rejects.toThrow(
      `Electron runtime mismatch: expected 43.6.0/darwin/x64, reported ${display}.`
    )
    expect(run).toHaveBeenCalledOnce()
  })

  it('fails closed when an existing binary cannot report its version', async () => {
    const fixture = rootFixture()
    writeRuntime(fixture)
    const run = vi.fn(() => ({ status: 1, signal: null, stdout: '', stderr: 'native load failed' }))
    const { ensureElectronRuntime } = await loadHelper()

    await expect(ensureElectronRuntime(options(fixture.root, run))).rejects.toThrow(
      'Electron runtime probe failed (exit 1): native load failed'
    )
    expect(run).toHaveBeenCalledOnce()
  })

  it('fails closed when the runtime probe reaches its timeout', async () => {
    const fixture = rootFixture()
    writeRuntime(fixture)
    const timeout = Object.assign(new Error('spawnSync Electron ETIMEDOUT'), { code: 'ETIMEDOUT' })
    const run = vi.fn(() => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: timeout }))
    const { ensureElectronRuntime } = await loadHelper()

    await expect(ensureElectronRuntime(options(fixture.root, run))).rejects.toThrow(
      'Electron runtime probe timed out after 15000ms.'
    )
  })

  it('fails closed on a nonzero official installer exit and never reports readiness', async () => {
    const fixture = rootFixture()
    const run = vi.fn(() => ({ status: 1, signal: null, stdout: '', stderr: 'checksum mismatch' }))
    const { ensureElectronRuntime } = await loadHelper()

    await expect(ensureElectronRuntime(options(fixture.root, run))).rejects.toThrow(
      'Official Electron installer failed (exit 1): checksum mismatch'
    )
    expect(run).toHaveBeenCalledOnce()
  })

  it('fails closed when the official installer reaches its timeout', async () => {
    const fixture = rootFixture()
    const timeout = Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT' })
    const run = vi.fn(() => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '', error: timeout }))
    const { ensureElectronRuntime } = await loadHelper()

    await expect(ensureElectronRuntime(options(fixture.root, run))).rejects.toThrow(
      'Official Electron installer timed out after 600000ms.'
    )
  })

  it('removes inherited redirect and checksum/TLS-relaxation variables from the official installer environment', async () => {
    const fixture = rootFixture()
    const run = vi.fn((command: string, _args: string[], invocation: { env: Record<string, string> }) => {
      expect(command).toBe(NODE)
      expect(invocation.env).toEqual({
        SENTINEL: 'kept',
        NODE_EXTRA_CA_CERTS: '/enterprise/ca.pem',
        HTTPS_PROXY: 'https://proxy.example',
        ELECTRON_INSTALL_PLATFORM: HOST_PLATFORM,
        ELECTRON_INSTALL_ARCH: HOST_ARCH,
        npm_config_platform: HOST_PLATFORM,
        npm_config_arch: HOST_ARCH
      })
      return { status: 1, signal: null, stdout: null, stderr: null }
    })
    const { ensureElectronRuntime } = await loadHelper()

    await expect(ensureElectronRuntime(options(fixture.root, run, {
      env: {
        SENTINEL: 'kept',
        NODE_OPTIONS: '--require=/tmp/injected.js',
        NODE_PATH: '/tmp/injected-modules',
        NODE_EXTRA_CA_CERTS: '/enterprise/ca.pem',
        HTTPS_PROXY: 'https://proxy.example',
        ELECTRON_OVERRIDE_DIST_PATH: '/tmp/untrusted-dist',
        electron_use_remote_checksums: '1',
        npm_config_electron_use_remote_checksums: 'true',
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        npm_config_strict_ssl: 'false'
      }
    }))).rejects.toThrow('Official Electron installer failed')
  })

  it('rejects a path.txt escape without executing an outside binary', async () => {
    const fixture = rootFixture()
    writeFileSync(join(fixture.electronDir, 'path.txt'), '../../../../outside-electron')
    const run = vi.fn()
    const { ensureElectronRuntime } = await loadHelper()

    await expect(ensureElectronRuntime(options(fixture.root, run))).rejects.toThrow(
      'Electron path.txt must resolve inside node_modules/electron/dist.'
    )
    expect(run).not.toHaveBeenCalled()
  })

  it.each(externalPathLinkCases)('rejects a %s external path.txt link before installer execution', async (_label, targetExists) => {
    const fixture = rootFixture()
    const outside = mkdtempSync(join(tmpdir(), 'metis-electron-outside-path-'))
    scratch.push(outside)
    const externalPathFile = join(outside, 'path.txt')
    if (targetExists) {
      if (process.platform === 'win32') mkdirSync(externalPathFile)
      else writeFileSync(externalPathFile, 'Electron.app/Contents/MacOS/Electron')
    }
    symlinkSync(externalPathFile, join(fixture.electronDir, 'path.txt'), process.platform === 'win32' ? 'junction' : 'file')
    const run = vi.fn()
    const { ensureElectronRuntime } = await loadHelper()

    await expect(ensureElectronRuntime(options(fixture.root, run))).rejects.toThrow(
      'Electron path.txt must be a package-local regular file, not a symlink.'
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects an external dist symlink before a missing runtime can invoke the installer', async () => {
    const fixture = rootFixture()
    const outside = mkdtempSync(join(tmpdir(), 'metis-electron-outside-dist-'))
    scratch.push(outside)
    symlinkSync(outside, join(fixture.electronDir, 'dist'), process.platform === 'win32' ? 'junction' : 'dir')
    const run = vi.fn()
    const { ensureElectronRuntime } = await loadHelper()

    await expect(ensureElectronRuntime(options(fixture.root, run))).rejects.toThrow(
      'Electron dist must resolve inside the actual node_modules/electron package directory.'
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects an external installer symlink before execution', async () => {
    const fixture = rootFixture()
    const outside = mkdtempSync(join(tmpdir(), 'metis-electron-outside-installer-'))
    scratch.push(outside)
    const externalInstaller = join(outside, 'install.js')
    if (process.platform === 'win32') mkdirSync(externalInstaller)
    else writeFileSync(externalInstaller, '// outside fixture\n')
    rmSync(fixture.installer)
    symlinkSync(externalInstaller, fixture.installer, process.platform === 'win32' ? 'junction' : 'file')
    const run = vi.fn()
    const { ensureElectronRuntime } = await loadHelper()

    await expect(ensureElectronRuntime(options(fixture.root, run))).rejects.toThrow(
      'Electron install.js must resolve inside the actual node_modules/electron package directory.'
    )
    expect(run).not.toHaveBeenCalled()
  })
})
