import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

const ownedHomes: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.doUnmock('../../electron.vite.config')
  vi.resetModules()
  for (const home of ownedHomes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('actual root Vitest reporter and fixture configuration', () => {
  it.each([
    { destination: true, githubActions: true },
    { destination: true, githubActions: false },
    { destination: false, githubActions: true }
  ])('connects the real root config for destination=$destination githubActions=$githubActions', async ({
    destination,
    githubActions
  }) => {
    vi.resetModules()
    // The Electron build settings are unrelated to this test. The actual root Vitest config,
    // sandbox factory and env builder execute unchanged inside the existing hermetic CI worker.
    vi.doMock('../../electron.vite.config', () => ({ default: {} }))
    const reportPath = join(tmpdir(), 'metis-config-report.json')
    const browserCache = join(tmpdir(), 'metis-config-browser-cache')
    vi.stubEnv('METIS_CI_ROOT_REPORT', destination ? ` ${reportPath} ` : ' ')
    vi.stubEnv('GITHUB_ACTIONS', githubActions ? 'true' : '')
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', browserCache)
    const previousHome = process.env.HOME
    const sandboxModule = await import('../hermetic/sandbox-env.mjs')
    const originalCreate = sandboxModule.createHermeticSandbox
    const create = vi.spyOn(sandboxModule, 'createHermeticSandbox').mockImplementation(() => {
      const sandbox = originalCreate()
      ownedHomes.push(sandbox.home)
      return sandbox
    })
    const loaded = await import('../../vitest.config')
    const config = loaded.default as unknown as {
      test: {
        env: Record<string, string | undefined>
        reporters?: unknown
        outputFile?: unknown
      }
    }
    expect(create).toHaveBeenCalledTimes(1)
    const sandbox = create.mock.results[0].value as ReturnType<typeof originalCreate>
    expect(existsSync(sandbox.tmp)).toBe(true)
    expect(sandbox.home).not.toBe(previousHome)
    for (const key of ['HOME', 'USERPROFILE', 'METIS_TEST_HOME', 'ASKTOTO_TEST_SANDBOX_ROOT']) {
      expect(config.test.env[key]).toBe(sandbox.home)
    }
    for (const key of ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']) {
      expect(config.test.env[key]).toBe('')
    }
    for (const key of ['TMPDIR', 'TMP', 'TEMP']) expect(config.test.env[key]).toBe(sandbox.tmp)
    expect(config.test.env.APPDATA).toBe(join(sandbox.home, 'AppData', 'Roaming'))
    expect(config.test.env.LOCALAPPDATA).toBe(join(sandbox.home, 'AppData', 'Local'))
    expect(config.test.env.PLAYWRIGHT_BROWSERS_PATH).toBe(browserCache)
    if (destination) {
      expect(config.test.reporters).toEqual(githubActions ? ['default', 'json', 'github-actions'] : ['default', 'json'])
      expect(config.test.outputFile).toEqual({ json: reportPath })
    } else {
      expect(config.test.reporters).toBeUndefined()
      expect(config.test.outputFile).toBeUndefined()
    }
  })
})
