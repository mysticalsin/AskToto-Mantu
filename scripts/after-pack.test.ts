import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const childProcess = vi.hoisted(() => ({ execFileSync: vi.fn() }))
vi.mock('node:child_process', () => childProcess)

import afterPack from './after-pack.mjs'
import { ensureLeanPackageCoreDirectories } from './lib/lean-package-stage.mjs'

const electronArchiveTools = createRequire(import.meta.url)('app-builder-lib/out/util/electronGet.js')

describe('afterPack Windows runtime verification', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    childProcess.execFileSync.mockReset()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('forwards the configured executable name to the packaged runtime verifier', async () => {
    const appOutDir = mkdtempSync(join(tmpdir(), 'metis-after-pack-'))
    temporaryDirectories.push(appOutDir)
    const resources = join(appOutDir, 'resources')
    mkdirSync(join(resources, 'ffmpeg', 'win32-x64'), { recursive: true })
    mkdirSync(join(resources, 'app.asar.unpacked', 'node_modules'), { recursive: true })
    writeFileSync(join(resources, 'ffmpeg', 'win32-x64', 'ffmpeg.exe'), 'test')

    await afterPack({
      arch: 1,
      electronPlatformName: 'win32',
      appOutDir,
      packager: { appInfo: { productFilename: 'Metis-Windows-Test' } }
    })

    expect(childProcess.execFileSync).toHaveBeenCalledWith(
      process.execPath,
      [
        expect.stringMatching(/check-packaged-runtime\.mjs$/),
        'win',
        resources,
        '--executable=Metis-Windows-Test.exe',
        '--post-sign'
      ],
      expect.objectContaining({ stdio: 'inherit' })
    )
    for (const name of ['operator', 'license-lease', 'cloudflare-embed']) {
      expect(existsSync(join(resources, name))).toBe(false)
    }
  })

  it('creates empty lean key directories before the unchanged package verifier runs', async () => {
    const appOutDir = mkdtempSync(join(tmpdir(), 'metis-after-pack-lean-'))
    temporaryDirectories.push(appOutDir)
    const resources = join(appOutDir, 'resources')
    mkdirSync(join(resources, 'ffmpeg', 'win32-x64'), { recursive: true })
    writeFileSync(join(resources, 'ffmpeg', 'win32-x64', 'ffmpeg.exe'), 'test')
    vi.stubEnv('METIS_PACKAGE_PROFILE', 'lean')
    const archive = Buffer.from(
      'UEsDBBQAAAAIAAAAIVD0kwwKIQAAAB8AAAAaAAAAcmVzb3VyY2VzL2RlZmF1bHRfYXBwLmFzYXLLL89LTVFwzUlNLinKz1NIS0wuyS+qVChJzS3ISSxJBQBQSwECFAMUAAAACAAAACFQ9JMMCiEAAAAfAAAAGgAAAAAAAAAAAAAAgAEAAAAAcmVzb3VyY2VzL2RlZmF1bHRfYXBwLmFzYXJQSwUGAAAAAAEAAQBIAAAAWQAAAAAA',
      'base64'
    )
    const archivePath = join(appOutDir, 'verified-electron.zip')
    writeFileSync(archivePath, archive)
    writeFileSync(join(resources, 'default_app.asar'), 'owned Electron factory template')
    vi.spyOn(electronArchiveTools, 'downloadElectronArtifactZip').mockResolvedValue(realpathSync(archivePath))
    childProcess.execFileSync.mockImplementation((executable, args) => {
      expect(existsSync(join(resources, 'default_app.asar'))).toBe(false)
      expect(executable).toBe(process.execPath)
      expect(args).toEqual([
        expect.stringMatching(/check-lean-package\.mjs$/),
        'win',
        resources,
        '--executable=Metis.exe',
        '--arch=x64'
      ])
      for (const name of ['operator', 'license-lease', 'cloudflare-embed']) {
        expect(lstatSync(join(resources, name)).isDirectory()).toBe(true)
      }
    })
    await afterPack({
      arch: 1,
      electronPlatformName: 'win32',
      appOutDir,
      packager: {
        appInfo: { productFilename: 'Metis' },
        config: {
          electronVersion: '43.6.0',
          electronDownload: {
            checksums: { 'electron-v43.6.0-win32-x64.zip': createHash('sha256').update(archive).digest('hex') }
          }
        }
      }
    })
    expect(childProcess.execFileSync).toHaveBeenCalledTimes(1)
  })

  it('removes a staged app directory when runtime verification fails', async () => {
    const appOutDir = mkdtempSync(join(tmpdir(), 'metis-after-pack-failure-'))
    temporaryDirectories.push(appOutDir)
    const resources = join(appOutDir, 'resources')
    mkdirSync(join(resources, 'ffmpeg', 'win32-x64'), { recursive: true })
    mkdirSync(join(resources, 'app.asar.unpacked', 'node_modules'), { recursive: true })
    writeFileSync(join(resources, 'ffmpeg', 'win32-x64', 'ffmpeg.exe'), 'test')
    childProcess.execFileSync.mockImplementation(() => {
      throw new Error('runtime payload mismatch')
    })

    await expect(
      afterPack({
        arch: 1,
        electronPlatformName: 'win32',
        appOutDir,
        packager: { appInfo: { productFilename: 'Metis' } }
      })
    ).rejects.toThrow('runtime payload mismatch')

    expect(existsSync(appOutDir)).toBe(false)
  })
})

describe('lean provisioned-key directory creation', () => {
  const roots: string[] = []
  function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'metis-lean-core-directories-'))
    roots.push(root)
    return root
  }
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('preserves real provisioned bytes and is repeatable without inserting placeholder files', async () => {
    const root = fixture()
    mkdirSync(join(root, 'operator'))
    const key = join(root, 'operator', 'pubkey.json')
    writeFileSync(key, 'public-test-key')
    await ensureLeanPackageCoreDirectories(root)
    await ensureLeanPackageCoreDirectories(root)
    expect(readFileSync(key, 'utf8')).toBe('public-test-key')
    for (const name of ['operator', 'license-lease', 'cloudflare-embed']) {
      expect(lstatSync(join(root, name)).isDirectory()).toBe(true)
      expect(existsSync(join(root, name, '.gitkeep'))).toBe(false)
    }
  })

  it('refuses an occupied regular file rather than replacing it', async () => {
    const root = fixture()
    writeFileSync(join(root, 'operator'), 'owned-file')
    await expect(ensureLeanPackageCoreDirectories(root)).rejects.toThrow('operator directory is invalid')
    expect(readFileSync(join(root, 'operator'), 'utf8')).toBe('owned-file')
  })

  it('refuses a linked key directory without changing its target', async () => {
    const root = fixture()
    const target = fixture()
    writeFileSync(join(target, 'existing.txt'), 'foreign')
    symlinkSync(target, join(root, 'operator'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(ensureLeanPackageCoreDirectories(root)).rejects.toThrow('operator directory is invalid')
    expect(readFileSync(join(target, 'existing.txt'), 'utf8')).toBe('foreign')
  })

  it('refuses a linked resource root without creating directories in its target', async () => {
    const parent = fixture()
    const target = fixture()
    const linked = join(parent, 'resources')
    symlinkSync(target, linked, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(ensureLeanPackageCoreDirectories(linked)).rejects.toThrow('resource root is invalid')
    expect(existsSync(join(target, 'operator'))).toBe(false)
  })
})

describe('afterPack macOS signature', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    childProcess.execFileSync.mockReset()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  function macFixture(): string {
    const appOutDir = mkdtempSync(join(tmpdir(), 'metis-after-pack-mac-'))
    temporaryDirectories.push(appOutDir)
    const resources = join(appOutDir, 'Metis.app', 'Contents', 'Resources')
    mkdirSync(join(resources, 'ffmpeg', 'darwin-arm64'), { recursive: true })
    mkdirSync(join(resources, 'app.asar.unpacked', 'node_modules'), { recursive: true })
    writeFileSync(join(resources, 'ffmpeg', 'darwin-arm64', 'ffmpeg'), 'test')
    return appOutDir
  }

  function codesignCall(args: unknown[]): [string, string[]] | undefined {
    return childProcess.execFileSync.mock.calls.find(
      (call: unknown[]) => call[0] === 'codesign' && (call[1] as string[]).includes(args[0] as string)
    ) as [string, string[]] | undefined
  }

  // Pinned: ad-hoc signing stays the default when no QA identity is configured.
  it('signs the final bundle ad-hoc by default', async () => {
    const appOutDir = macFixture()
    vi.stubEnv('ASKTOTO_ADHOC_SIGN', '1')
    vi.stubEnv('ASKTOTO_MAC_ARCHES', '')

    await afterPack({
      arch: 3,
      electronPlatformName: 'darwin',
      appOutDir,
      packager: { appInfo: { productFilename: 'Metis' } }
    })

    const app = join(appOutDir, 'Metis.app')
    const signCall = codesignCall(['--sign'])
    expect(signCall).toBeDefined()
    const signIndex = signCall![1].indexOf('--sign')
    expect(signCall![1][signIndex + 1]).toBe('-')
    const verifyCall = codesignCall(['--verify'])
    expect(verifyCall![1]).toEqual(['--verify', '--deep', '--strict', '--verbose=2', app])
  })

  // Invariant: when the lane provides a stable QA identity, it must reach codesign, never fall back to '-'.
  it('signs with the QA identity when the lane provides one', async () => {
    const appOutDir = macFixture()
    const identity = 'A'.repeat(40)
    vi.stubEnv('ASKTOTO_ADHOC_SIGN', '1')
    vi.stubEnv('ASKTOTO_MAC_ARCHES', '')
    vi.stubEnv('ASKTOTO_MAC_SIGN_IDENTITY', identity)

    await afterPack({
      arch: 3,
      electronPlatformName: 'darwin',
      appOutDir,
      packager: { appInfo: { productFilename: 'Metis' } }
    })

    const signCall = codesignCall(['--sign'])
    expect(signCall).toBeDefined()
    const signIndex = signCall![1].indexOf('--sign')
    expect(signCall![1][signIndex + 1]).toBe(identity)
  })
})
