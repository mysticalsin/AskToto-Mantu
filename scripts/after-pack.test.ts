import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
        '--executable=Metis-Windows-Cahe.exe'
      ],
      expect.objectContaining({ stdio: 'inherit' })
    )
  })
})
