import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const childProcess = vi.hoisted(() => ({ execFileSync: vi.fn() }))
vi.mock('node:child_process', () => childProcess)

async function loadBeforePack() {
  vi.resetModules()
  return (await import('./before-pack.mjs')).default
}

describe('beforePack runtime-asset gate', () => {
  beforeEach(() => {
    childProcess.execFileSync.mockReset()
  })

  it('rejects missing reviewed ASR assets before electron-builder stages an app directory', async () => {
    const beforePack = await loadBeforePack()

    await beforePack()
    await beforePack()

    expect(childProcess.execFileSync).toHaveBeenCalledTimes(1)
    expect(childProcess.execFileSync).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/check-runtime-assets\.mjs$/)],
      expect.objectContaining({ stdio: 'inherit' })
    )
  })

  it('propagates a runtime-asset check failure without caching the failed validation', async () => {
    const beforePack = await loadBeforePack()
    const failure = new Error('reviewed runtime asset is missing')
    childProcess.execFileSync.mockImplementationOnce(() => {
      throw failure
    })

    await expect(beforePack()).rejects.toThrow(failure)

    await beforePack()
    await beforePack()

    expect(childProcess.execFileSync).toHaveBeenCalledTimes(2)
  })

  it('registers the gate in electron-builder configuration', () => {
    const config = readFileSync(join(__dirname, '..', 'electron-builder.yml'), 'utf8')
    expect(config).toMatch(/^beforePack: scripts\/before-pack\.mjs$/m)
  })
})
