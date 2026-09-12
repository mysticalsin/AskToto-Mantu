import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  host: 'darwin',
  spawn: vi.fn((_command: string, _arguments: string[], _options: unknown) => ({ status: 0 })),
  remove: vi.fn()
}))
vi.mock('node:child_process', () => ({ spawnSync: mocks.spawn }))
vi.mock('node:fs', () => ({ existsSync: () => false, readdirSync: () => [], rmSync: mocks.remove }))
vi.mock('node:os', () => ({ platform: () => mocks.host, tmpdir: () => '/tmp' }))

const originalArguments = process.argv
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubEnv('ASKTOTO_INSTALLER_OUTPUT_DIR', 'fixture-installers')
  vi.stubEnv('ASKTOTO_SIGN_INSTALLER', '')
  vi.stubEnv('WIN_CSC_LINK', '')
  vi.stubEnv('WIN_CSC_KEY_PASSWORD', '')
  vi.stubEnv('WIN_CSC_EXPECTED_SUBJECT', '')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  process.argv = originalArguments
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function plan(host: string, target: string) {
  mocks.host = host
  process.argv = [process.execPath, 'scripts/build-installers.mjs', target]
  await import('./build-installers.mjs')
  return mocks.spawn.mock.calls.map((call) => [call[0], ...call[1]].join(' ').replace(/\\/g, '/'))
}

describe('MQA-302 local installer verification parity', () => {
  it('provisions managed Dust Node and speaker models before packaging a Mac build', async () => {
    const commands = await plan('darwin', 'mac')
    const pack = commands.findIndex((command) => command.startsWith('npx electron-builder'))
    expect(commands[0]).toBe('node scripts/check-build-host.mjs mac')
    for (const prerequisite of ['fetch-managed-node.mjs mac', 'fetch-speaker-model.mjs']) {
      const index = commands.indexOf(`node scripts/${prerequisite}`)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(pack)
    }
    expect(commands).toContain('node scripts/check-sherpa-platform.mjs mac arm64')
    expect(commands).toContain('node scripts/check-sherpa-platform.mjs mac x64')
    const bundleBuild = mocks.spawn.mock.calls.find((call) => call[0] === 'npm' && (call[1] as string[]).includes('build'))
    expect((bundleBuild?.[2] as { env: NodeJS.ProcessEnv }).env.ASKTOTO_MAC_UNIVERSAL).toBe('1')
    expect(commands[pack]).toContain('--universal')
    expect(commands).toContain('node scripts/verify-signing.mjs fixture-installers')
    expect(commands).toContain('node scripts/check-packaged-launch.mjs fixture-installers/mac-universal/Metis.app')
    expect(commands).toContain('node scripts/check-embedded-cloudflare-key.mjs fixture-installers')
  })

  it('launches and transcribes through the actual Windows output before reporting success', async () => {
    const commands = await plan('win32', 'win')
    expect(commands[0]).toBe('node scripts/check-build-host.mjs win')
    expect(commands).toContain('node scripts/fetch-managed-node.mjs win')
    expect(commands).toContain('node scripts/fetch-speaker-model.mjs')
    expect(commands).toContain('node scripts/check-packaged-launch.mjs fixture-installers/win-unpacked/Metis.exe')
    expect(commands).toContain('node scripts/check-packaged-asr.mjs fixture-installers/win-unpacked/Metis.exe')
    // Development artifacts remain buildable without a publisher certificate.
    expect(commands).not.toContain('node scripts/verify-signing.mjs fixture-installers')
  })

  it('verifies certificate identity when local Windows signing is configured', async () => {
    vi.stubEnv('WIN_CSC_LINK', 'fixture-certificate')
    vi.stubEnv('WIN_CSC_KEY_PASSWORD', 'fixture-password')
    vi.stubEnv('WIN_CSC_EXPECTED_SUBJECT', 'Metis Signing Fixture')
    const commands = await plan('win32', 'win')
    expect(commands).toContain('node scripts/verify-signing.mjs fixture-installers')
  })
})
