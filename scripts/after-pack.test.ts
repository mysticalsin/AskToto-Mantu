import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const childProcess = vi.hoisted(() => ({ execFileSync: vi.fn() }))
vi.mock('node:child_process', () => childProcess)

import afterPack from './after-pack.mjs'

describe('afterPack Windows runtime verification', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    childProcess.execFileSync.mockReset()
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
      packager: { appInfo: { productFilename: 'Metis-Windows-Cahe' } }
    })

    expect(childProcess.execFileSync).toHaveBeenCalledWith(
      process.execPath,
      [
        expect.stringMatching(/check-packaged-runtime\.mjs$/),
        'win',
        resources,
        '--executable=Metis-Windows-Cahe.exe',
        '--post-sign'
      ],
      expect.objectContaining({ stdio: 'inherit' })
    )
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

describe('afterPack macOS signature', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    childProcess.execFileSync.mockReset()
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
