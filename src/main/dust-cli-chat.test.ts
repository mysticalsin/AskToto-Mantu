import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

vi.mock('electron')
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn()
}))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, writeFileSync: vi.fn(fs.writeFileSync) }
})
vi.mock('./managed-node', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./managed-node')>()),
  ensureManagedNode: vi.fn(),
  resolveManagedNode: vi.fn(),
  vcredistExePath: vi.fn(() => null)
}))
vi.mock('./cli-installer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./cli-installer')>()),
  managedCliEntry: vi.fn(),
  installManagedCli: vi.fn()
}))

import { DUST_SPOTLIGHT_REF_AGENT_ID } from '@shared/ipc'
import {
  buildDustSpotlightChatArgv,
  classifyDustCliChatFailure,
  clearSeededDustCliSession,
  dustChatArgvHasWithTools,
  dustChatEnv,
  messageForDustCliKind,
  parseDustChatStdout,
  projectNameForDataAndAiAsk,
  runManagedDustChat,
  spotlightRefMissingAgentMessage,
  spotlightRefMissingCliMessage,
  writeDustKeytarSeedScript
} from './dust-cli-chat'
import { MANAGED_CLIS, installManagedCli, managedCliEntry } from './cli-installer'
import { ensureManagedNode, resolveManagedNode } from './managed-node'

describe('managed Dust preparation cancellation', () => {
  let dir: string
  let children: ChildProcess[]
  let releaseReadiness: (() => void) | undefined
  let pending: Promise<unknown> | undefined
  const opts = { message: 'Synthetic request', apiKey: 'qa-only-invalid-token', workspaceId: 'qa-workspace' }
  const barrier = async (): Promise<void> => {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  const canceled = { ok: false, kind: 'error', error: 'Dust chat canceled.' }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    dir = mkdtempSync(join(tmpdir(), 'metis-dust-cancel-'))
    children = []
    pending = undefined
    releaseReadiness = undefined
    vi.mocked(writeFileSync).mockClear()
    vi.mocked(ensureManagedNode).mockReset().mockResolvedValue(null)
    vi.mocked(resolveManagedNode).mockReset().mockReturnValue(null)
    vi.mocked(managedCliEntry)
      .mockReset()
      .mockReturnValue({ entry: join(dir, 'index.js'), version: '0.4.5' })
    vi.mocked(installManagedCli).mockReset()
    vi.mocked(spawn)
      .mockReset()
      .mockImplementation(() => {
        const child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
          kill: vi.fn()
        }) as unknown as ChildProcess
        children.push(child)
        return child
      })
  })

  afterEach(async () => {
    try {
      releaseReadiness?.()
      await barrier()
      // Settle any child the unchanged RED implementation started, including a late chat.
      for (let i = 0; i < children.length; i++) {
        children[i].emit('close', 0)
        await barrier()
      }
      await pending
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      try {
        vi.useRealTimers()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it('refuses a pre-aborted signal before readiness or seed effects', async () => {
    const controller = new AbortController()
    controller.abort()
    pending = runManagedDustChat({ ...opts, signal: controller.signal })
    await barrier()
    expect(ensureManagedNode).not.toHaveBeenCalled()
    expect(installManagedCli).not.toHaveBeenCalled()
    expect(writeFileSync).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    await expect(pending).resolves.toEqual(canceled)
  })

  it.each(['success', 'failure'] as const)('refuses seed effects after canceled readiness %s', async (outcome) => {
    let resolve!: (value: null) => void
    let reject!: (error: Error) => void
    vi.mocked(ensureManagedNode).mockReturnValueOnce(
      new Promise((yes, no) => {
        resolve = yes
        reject = no
      })
    )
    releaseReadiness = () => resolve(null)
    const controller = new AbortController()
    let settled = false
    pending = runManagedDustChat({ ...opts, signal: controller.signal }).then((result) => {
      settled = true
      return result
    })
    expect(ensureManagedNode).toHaveBeenCalledTimes(1)
    controller.abort()
    await barrier()
    expect(settled).toBe(false)
    if (outcome === 'success') resolve(null)
    else reject(new Error('synthetic readiness failure'))
    await barrier()
    expect(writeFileSync).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(installManagedCli).not.toHaveBeenCalled()
    await expect(pending).resolves.toEqual(canceled)
  })

  it.each([
    'close',
    'error'
  ] as const)('awaits the started seeder %s and refuses a new chat after abort', async (event) => {
    const controller = new AbortController()
    let settled = false
    pending = runManagedDustChat({ ...opts, signal: controller.signal }).then((result) => {
      settled = true
      return result
    })
    await barrier()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(writeFileSync).toHaveBeenCalledTimes(1)
    controller.abort()
    await barrier()
    expect(settled).toBe(false)
    children[0].emit(event, event === 'close' ? 0 : new Error('synthetic seeder failure'))
    await barrier()
    expect(spawn).toHaveBeenCalledTimes(1)
    await expect(pending).resolves.toEqual(canceled)
  })

  it.each(['omitted', 'active'] as const)('preserves healthy %s signal, credentials and argv', async (mode) => {
    pending = runManagedDustChat({ ...opts, ...(mode === 'active' ? { signal: new AbortController().signal } : {}) })
    await barrier()
    expect(spawn).toHaveBeenCalledTimes(1)
    children[0].emit('close', 0)
    await barrier()
    expect(spawn).toHaveBeenCalledTimes(2)
    const [seed, chat] = vi.mocked(spawn).mock.calls
    expect(seed[1]).toEqual([join(dir, '.metis-seed-session.mjs'), 'us-central1'])
    expect(chat[1]).toEqual([join(dir, 'index.js'), ...buildDustSpotlightChatArgv({ message: opts.message })])
    for (const call of [seed, chat]) {
      expect(call[1]).not.toContain(opts.apiKey)
      expect(call[1]).not.toContain(opts.workspaceId)
      expect(call[2]?.env).toMatchObject({ DUST_API_KEY: opts.apiKey, DUST_WORKSPACE_ID: opts.workspaceId })
    }
    expect(readFileSync(join(dir, '.metis-seed-session.mjs'), 'utf8')).not.toContain(opts.apiKey)
    children[1].stdout?.emit('data', Buffer.from('{"agentAnswer":"synthetic answer"}'))
    children[1].emit('close', 0)
    await expect(pending).resolves.toEqual({ ok: true, text: 'synthetic answer' })
  })
})

describe('managed Dust CLI install id', () => {
  it('exists on MANAGED_CLIS with the published package and entry', () => {
    expect(MANAGED_CLIS.dust.id).toBe('dust')
    expect(MANAGED_CLIS.dust.npmPackage).toBe('@dust-tt/dust-cli')
    expect(MANAGED_CLIS.dust.binRelPath).toBe('dist/index.js')
  })
})

describe('Spotlight Ref dust chat argv', () => {
  it('MQA-315 cannot opt credentials into a process command line', () => {
    const opts = {
      message: 'Synthetic request',
      passKeyOnArgv: true,
      apiKey: 'qa-only-invalid-token',
      workspaceId: 'qa-workspace'
    }
    const args = buildDustSpotlightChatArgv(opts)
    expect(args).not.toContain(opts.apiKey)
    expect(args).not.toContain('--key')
    const source = readFileSync(join(__dirname, 'dust-cli-chat.ts'), 'utf8')
    expect(source).toContain('spawn(nodeBin, [seed, dustRegionFromBaseUrl(opts.baseUrl)]')
  })

  it('MQA-315 seeds the keychain from child environment without secret argv', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-dust-seed-'))
    try {
      const fakeKeytar = join(dir, 'node_modules', 'keytar')
      mkdirSync(fakeKeytar, { recursive: true })
      writeFileSync(
        join(fakeKeytar, 'package.json'),
        JSON.stringify({ name: 'keytar', type: 'module', main: 'index.js' })
      )
      writeFileSync(
        join(fakeKeytar, 'index.js'),
        'export default { async setPassword(...args) { console.log(JSON.stringify(args)) } }'
      )
      const script = writeDustKeytarSeedScript(dir)
      const token = 'qa-only-invalid-token'
      const result = spawnSync(process.execPath, [script, 'us-central1'], {
        env: { ...process.env, DUST_API_KEY: token, DUST_WORKSPACE_ID: 'qa-workspace' },
        encoding: 'utf8'
      })
      expect(result.status).toBe(0)
      const calls = result.stdout
        .split('\n')
        .filter((line) => line.startsWith('['))
        .map((line) => JSON.parse(line))
      expect(calls).toEqual([
        ['dust-cli', 'access_token', token],
        ['dust-cli', 'workspace_sid', 'qa-workspace'],
        ['dust-cli', 'region', 'us-central1']
      ])
      expect(readFileSync(script, 'utf8')).not.toContain(token)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('D9-3 disconnect removes the seeded dust-cli items', () => {
    const accounts = ['access_token', 'workspace_sid', 'region']
    /** A keytar stand-in backed by a JSON file, so state survives the separate seeder processes. */
    function fakeKeytarStore(dir: string, initial: Record<string, string>): { statePath: string } {
      const fakeKeytar = join(dir, 'node_modules', 'keytar')
      mkdirSync(fakeKeytar, { recursive: true })
      writeFileSync(
        join(fakeKeytar, 'package.json'),
        JSON.stringify({ name: 'keytar', type: 'module', main: 'index.js' })
      )
      const statePath = join(dir, 'keychain.json')
      writeFileSync(statePath, JSON.stringify(initial))
      writeFileSync(
        join(fakeKeytar, 'index.js'),
        [
          "import { readFileSync, writeFileSync } from 'node:fs'",
          'const path = process.env.FAKE_KEYCHAIN',
          'const load = () => JSON.parse(readFileSync(path, "utf8"))',
          'const save = (s) => writeFileSync(path, JSON.stringify(s))',
          'export default {',
          '  async setPassword(svc, acct, v) { const s = load(); s[svc + "/" + acct] = v; save(s) },',
          '  async getPassword(svc, acct) { return load()[svc + "/" + acct] ?? null },',
          '  async deletePassword(svc, acct) { const s = load(); const had = (svc + "/" + acct) in s; delete s[svc + "/" + acct]; save(s); return had }',
          '}'
        ].join('\n')
      )
      return { statePath }
    }

    it("disconnect clears the seeded dust-cli items only when they hold Métis's token", () => {
      const dir = mkdtempSync(join(tmpdir(), 'metis-dust-unseed-'))
      try {
        const metisToken = 'qa-only-metis-token'
        const seeded = {
          'dust-cli/access_token': metisToken,
          'dust-cli/workspace_sid': 'qa-workspace',
          'dust-cli/region': 'us-central1'
        }
        const { statePath } = fakeKeytarStore(dir, seeded)
        const script = writeDustKeytarSeedScript(dir)
        const run = (token: string): ReturnType<typeof spawnSync> =>
          spawnSync(process.execPath, [script, '--clear-if-match'], {
            env: { ...process.env, DUST_API_KEY: token, FAKE_KEYCHAIN: statePath },
            encoding: 'utf8'
          })

        // A different token in the keychain is the user's own CLI session: it must survive.
        const other = run('qa-only-some-other-token')
        expect(other.status).toBe(0)
        expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(seeded)

        // The stored token is Métis's: every seeded item goes.
        const mine = run(metisToken)
        expect(mine.status).toBe(0)
        const after = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, string>
        for (const account of accounts) expect(after[`dust-cli/${account}`]).toBeUndefined()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('a token-less clear is a no-op and never deletes anything', () => {
      const dir = mkdtempSync(join(tmpdir(), 'metis-dust-unseed-'))
      try {
        const seeded = { 'dust-cli/access_token': 'qa-only-user-token', 'dust-cli/workspace_sid': 'qa-workspace' }
        const { statePath } = fakeKeytarStore(dir, seeded)
        const script = writeDustKeytarSeedScript(dir)
        const env = { ...process.env, FAKE_KEYCHAIN: statePath } as Record<string, string | undefined>
        delete env.DUST_API_KEY
        spawnSync(process.execPath, [script, '--clear-if-match'], { env, encoding: 'utf8' })
        expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(seeded)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  it('contains --sId GOr913Zr5V and -m and never --with-tools', () => {
    const args = buildDustSpotlightChatArgv({ message: 'Data and AI projects' })
    expect(args).toContain('chat')
    expect(args).toContain('--sId')
    expect(args[args.indexOf('--sId') + 1]).toBe(DUST_SPOTLIGHT_REF_AGENT_ID)
    expect(args).toContain('-m')
    expect(args[args.indexOf('-m') + 1]).toBe('Data and AI projects')
    expect(dustChatArgvHasWithTools(args)).toBe(false)
    expect(args).not.toContain('--with-tools')
    expect(args).not.toContain('-t')
  })

  it('adds --projectName only when a real name is supplied — does not invent one', () => {
    const without = buildDustSpotlightChatArgv({ message: 'hello' })
    expect(without).not.toContain('--projectName')
    const withName = buildDustSpotlightChatArgv({ message: 'hello', projectName: 'Data and AI' })
    expect(withName).toContain('--projectName')
    expect(withName[withName.indexOf('--projectName') + 1]).toBe('Data and AI')
  })

  it('headless env uses DUST_API_KEY + DUST_WORKSPACE_ID', () => {
    expect(dustChatEnv({ apiKey: 'sk-test', workspaceId: 'ws_1' })).toEqual({
      CI: '1',
      DUST_API_KEY: 'sk-test',
      DUST_WORKSPACE_ID: 'ws_1'
    })
  })
})

describe('missing CLI is install, not reconnect', () => {
  it('classifies a missing binary as missing-cli and names Set up Dust / install', () => {
    expect(classifyDustCliChatFailure('spawn dust ENOENT', { cliInstalled: false })).toBe('missing-cli')
    const msg = messageForDustCliKind('missing-cli', 'nope')
    expect(msg).toBe(spotlightRefMissingCliMessage())
    expect(msg.toLowerCase()).toMatch(/install|set up dust/)
    expect(msg.toLowerCase()).not.toContain('reconnect')
  })

  it('classifies an agent miss as not-in-this-workspace, not reconnect', () => {
    expect(classifyDustCliChatFailure('Error: Agent not found: No agent found matching "Spotlight Ref"')).toBe(
      'missing-agent'
    )
    const msg = spotlightRefMissingAgentMessage()
    expect(msg.toLowerCase()).toContain('not in this workspace')
    expect(msg.toLowerCase()).not.toContain('reconnect')
  })
})

describe('parseDustChatStdout', () => {
  it('reads agentAnswer from the CLI JSON', () => {
    const r = parseDustChatStdout(
      JSON.stringify({ agentId: 'GOr913Zr5V', agentAnswer: 'Data and AI, AI wiki', conversationId: 'c1' })
    )
    expect(r.agentAnswer).toBe('Data and AI, AI wiki')
  })
})

describe('projectNameForDataAndAiAsk', () => {
  it('passes --projectName only for a real "Data and AI" name Dust returned', () => {
    expect(projectNameForDataAndAiAsk('Data and AI projects', ['Sales', 'Data and AI'])).toBe('Data and AI')
    expect(projectNameForDataAndAiAsk('Data and AI projects', ['Sales wiki'])).toBeUndefined()
    expect(projectNameForDataAndAiAsk('hello', ['Data and AI'])).toBeUndefined()
  })
})

describe('clearSeededDustCliSession — disconnect cleanup of the shared dust-cli keychain', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metis-dust-unseed-fn-'))
    vi.mocked(resolveManagedNode).mockReset().mockReturnValue(null)
    vi.mocked(managedCliEntry).mockReset()
    vi.mocked(spawn).mockReset()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('tolerates a missing managed CLI: nothing to clean, nothing spawned, never throws', async () => {
    vi.mocked(managedCliEntry).mockReturnValue(null)
    await expect(clearSeededDustCliSession('qa-only-metis-token')).resolves.toEqual({ cleared: false })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('does nothing without a token to compare against', async () => {
    vi.mocked(managedCliEntry).mockReturnValue({ entry: join(dir, 'index.js'), version: '0.4.5' })
    await expect(clearSeededDustCliSession('')).resolves.toEqual({ cleared: false })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('runs the seeder in clear-if-match mode with the token in env only, never argv', async () => {
    vi.mocked(managedCliEntry).mockReturnValue({ entry: join(dir, 'index.js'), version: '0.4.5' })
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn()
      }) as unknown as ChildProcess
      setImmediate(() => {
        child.stdout?.emit('data', Buffer.from('cleared\n'))
        child.emit('close', 0)
      })
      return child
    })
    const token = 'qa-only-metis-token'
    await expect(clearSeededDustCliSession(token)).resolves.toEqual({ cleared: true })
    expect(spawn).toHaveBeenCalledTimes(1)
    const [, args, options] = vi.mocked(spawn).mock.calls[0]
    expect(args).toEqual([join(dir, '.metis-seed-session.mjs'), '--clear-if-match'])
    expect(args).not.toContain(token)
    expect(options?.env).toMatchObject({ DUST_API_KEY: token })
  })

  it("reports not cleared when the keychain holds someone else's token", async () => {
    vi.mocked(managedCliEntry).mockReturnValue({ entry: join(dir, 'index.js'), version: '0.4.5' })
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn()
      }) as unknown as ChildProcess
      setImmediate(() => {
        child.stdout?.emit('data', Buffer.from('kept\n'))
        child.emit('close', 0)
      })
      return child
    })
    await expect(clearSeededDustCliSession('qa-only-metis-token')).resolves.toEqual({ cleared: false })
  })

  it('a seeder that fails to start is reported as not cleared, never thrown', async () => {
    vi.mocked(managedCliEntry).mockReturnValue({ entry: join(dir, 'index.js'), version: '0.4.5' })
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn()
      }) as unknown as ChildProcess
      setImmediate(() => child.emit('error', new Error('spawn ENOENT')))
      return child
    })
    await expect(clearSeededDustCliSession('qa-only-metis-token')).resolves.toEqual({ cleared: false })
  })
})
