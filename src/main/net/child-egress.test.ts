import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false },
  shell: { openPath: vi.fn() }
}))
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  const execFile: unknown = vi.fn()
  ;(execFile as Record<symbol, unknown>)[promisify.custom] = h.execFile
  return { execFile, spawn: h.spawn }
})

import { cliEnv, runCliStream, testCli } from '../cli'
import { startFfmpegDecode } from '../ffmpeg-decoder'
import { runManagedDustChat } from '../dust-cli-chat'
import { DEAD_PROXY_URL, setActiveEgressPolicy } from './egress-policy'

// Child processes open their own sockets, so under a managed egressAllowlist the CLI providers are refused at
// spawn and every other child gets a proxy environment pinned to the policy (docs/NETWORK-EGRESS.md).
beforeEach(() => {
  h.spawn.mockReset()
  h.execFile.mockReset()
  setActiveEgressPolicy(['graph.microsoft.com'])
})
afterEach(() => setActiveEgressPolicy(null))

describe('CLI providers under a managed egressAllowlist', () => {
  it('runCliStream reports the policy and never spawns', async () => {
    const onError = vi.fn()
    runCliStream({
      providerId: 'claude-cli',
      model: 'sonnet',
      system: '',
      prompt: 'hi',
      handlers: { onDelta: vi.fn(), onDone: vi.fn(), onError }
    })
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    expect(onError.mock.calls[0][0]).toMatch(/egressAllowlist/)
    expect(h.spawn).not.toHaveBeenCalled()
    expect(h.execFile).not.toHaveBeenCalled()
  })

  it('testCli refuses for both CLI providers without resolving or spawning a binary', async () => {
    for (const provider of ['claude-cli', 'codex-cli'] as const) {
      await expect(testCli(provider)).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/egressAllowlist/) })
    }
    expect(h.spawn).not.toHaveBeenCalled()
    expect(h.execFile).not.toHaveBeenCalled()
  })

  it('the Dust CLI chat child is refused before anything is ensured or spawned', async () => {
    await expect(
      runManagedDustChat({ message: 'hi', apiKey: 'k', workspaceId: 'w' })
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/egressAllowlist/) })
    expect(h.spawn).not.toHaveBeenCalled()
  })

  it('cliEnv pins every proxy variable for the probes that still run', () => {
    const saved = process.env.HTTPS_PROXY
    process.env.HTTPS_PROXY = 'http://corp-proxy:3128'
    try {
      expect(cliEnv('claude-cli').HTTPS_PROXY).toBe(DEAD_PROXY_URL)
      expect(cliEnv('codex-cli').http_proxy).toBe(DEAD_PROXY_URL)
    } finally {
      if (saved === undefined) delete process.env.HTTPS_PROXY
      else process.env.HTTPS_PROXY = saved
    }
  })

  it('without a policy cliEnv leaves the proxy environment alone', () => {
    setActiveEgressPolicy(null)
    const saved = process.env.HTTPS_PROXY
    process.env.HTTPS_PROXY = 'http://corp-proxy:3128'
    try {
      expect(cliEnv('codex-cli').HTTPS_PROXY).toBe('http://corp-proxy:3128')
    } finally {
      if (saved === undefined) delete process.env.HTTPS_PROXY
      else process.env.HTTPS_PROXY = saved
    }
  })
})

describe('ffmpeg under a managed egressAllowlist', () => {
  it('the decode child is spawned with a pinned proxy environment (the duration probe shares the same option)', () => {
    const envs: NodeJS.ProcessEnv[] = []
    h.spawn.mockImplementation((_cmd: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      envs.push(options.env ?? {})
      throw new Error('spawn stubbed')
    })
    const onError = vi.fn(async () => {})
    startFfmpegDecode('ffmpeg-stub', '/nonexistent/recording.wav', 0, {
      onChunk: async () => {},
      onComplete: async () => {},
      onError
    })
    expect(envs).toHaveLength(1)
    expect(envs[0].HTTPS_PROXY).toBe(DEAD_PROXY_URL)
    expect(envs[0].ALL_PROXY).toBe(DEAD_PROXY_URL)
    expect(envs[0].NO_PROXY).toBe('')
  })
})
