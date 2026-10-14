import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readManagedSpeechPolicy, readManagedSpeechProviders } from './managed-speech-providers'

const openRace = vi.hoisted(() => ({ failPath: '', attempts: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      const [path] = args
      if (openRace.failPath === path) {
        openRace.attempts += 1
        return Promise.reject(Object.assign(new Error('synthetic disappearance'), { code: 'ENOENT' }))
      }
      return actual.open(...args)
    }
  }
})

const temporaryDirectories: string[] = []

function policyFiles(): { directory: string; userPath: string; adminPath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'managed-speech-providers-'))
  temporaryDirectories.push(directory)
  return { directory, userPath: join(directory, 'user.json'), adminPath: join(directory, 'admin.json') }
}

afterEach(() => {
  openRace.failPath = ''
  openRace.attempts = 0
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('readManagedSpeechProviders', () => {
  it('uses explicit admin restrictions over user policy, including empty deny-all', async () => {
    const { userPath, adminPath } = policyFiles()
    writeFileSync(userPath, JSON.stringify({ allowedProviders: ['deepgram-nova3'] }))
    writeFileSync(adminPath, JSON.stringify({ allowedProviders: [] }))
    const readTrustedAdminBytes = vi.fn((path: string) => readFileSync(path))

    expect(await readManagedSpeechProviders(userPath, adminPath, readTrustedAdminBytes)).toEqual({
      state: 'valid',
      providers: []
    })
    expect(readTrustedAdminBytes).toHaveBeenCalledWith(adminPath)
  })

  it('falls back to user policy only when the trusted admin file omits the key', async () => {
    const { userPath, adminPath } = policyFiles()
    writeFileSync(userPath, JSON.stringify({ allowedProviders: ['deepgram-nova3', 'cloudflare-nova3'] }))
    writeFileSync(adminPath, JSON.stringify({ lockedKeys: ['provider'] }))

    expect(await readManagedSpeechProviders(userPath, adminPath, (path) => readFileSync(path))).toEqual({
      state: 'valid',
      providers: ['deepgram-nova3', 'cloudflare-nova3']
    })
  })

  it('fails closed for an existing but untrusted admin policy', async () => {
    const { userPath, adminPath } = policyFiles()
    writeFileSync(userPath, JSON.stringify({ allowedProviders: ['deepgram-nova3'] }))
    writeFileSync(adminPath, JSON.stringify({ allowedProviders: ['cloudflare-nova3'] }))

    expect(await readManagedSpeechProviders(userPath, adminPath, () => null)).toEqual({ state: 'invalid' })
  })

  it('uses user policy when admin file is absent and reports absent when neither has the key', async () => {
    const { userPath, adminPath } = policyFiles()
    writeFileSync(userPath, JSON.stringify({ allowedProviders: ['deepgram-nova3'] }))
    expect(await readManagedSpeechProviders(userPath, adminPath, () => null)).toEqual({
      state: 'valid',
      providers: ['deepgram-nova3']
    })
    writeFileSync(userPath, JSON.stringify({ lockedKeys: [] }))
    expect(await readManagedSpeechProviders(userPath, adminPath, () => null)).toEqual({ state: 'absent' })
  })

  it('treats malformed JSON, non-array values, and nonstring entries as invalid', async () => {
    const { userPath, adminPath } = policyFiles()
    for (const content of ['{', '{"allowedProviders":{}}', '{"allowedProviders":["deepgram-nova3",2]}', 'null']) {
      writeFileSync(userPath, content)
      expect(await readManagedSpeechProviders(userPath, adminPath, () => null)).toEqual({ state: 'invalid' })
    }
  })

  it('fails closed if a configured user policy disappears between inspection and open', async () => {
    const { userPath, adminPath } = policyFiles()
    writeFileSync(userPath, JSON.stringify({ allowedProviders: ['deepgram-nova3'] }))
    openRace.failPath = userPath
    openRace.attempts = 0

    expect(await readManagedSpeechProviders(userPath, adminPath, () => null)).toEqual({ state: 'invalid' })
    expect(openRace.attempts).toBe(1)
  })

  it('rejects symlinks, nonregular files, and files larger than the fixed byte cap', async () => {
    const { directory, userPath, adminPath } = policyFiles()
    const target = join(directory, 'target.json')
    writeFileSync(target, JSON.stringify({ allowedProviders: ['deepgram-nova3'] }))
    symlinkSync(target, userPath)
    expect(await readManagedSpeechProviders(userPath, adminPath, () => null)).toEqual({ state: 'invalid' })

    expect(await readManagedSpeechProviders(directory, adminPath, () => null)).toEqual({ state: 'invalid' })
    unlinkSync(userPath)
    writeFileSync(userPath, Buffer.alloc(1_048_577, 0x20))
    expect(lstatSync(userPath).isFile()).toBe(true)
    expect(await readManagedSpeechProviders(userPath, adminPath, () => null)).toEqual({ state: 'invalid' })
  })

  it('rejects an admin symlink before asking the trusted reader for content', async () => {
    const { userPath, adminPath, directory } = policyFiles()
    const target = join(directory, 'target.json')
    writeFileSync(target, JSON.stringify({ allowedProviders: ['deepgram-nova3'] }))
    symlinkSync(target, adminPath)
    const readTrustedAdminBytes = vi.fn(() => null)

    expect(await readManagedSpeechProviders(userPath, adminPath, readTrustedAdminBytes)).toEqual({ state: 'invalid' })
    expect(readTrustedAdminBytes).not.toHaveBeenCalled()
  })

  it('treats a trusted admin reader failure as invalid rather than falling back', async () => {
    const { userPath, adminPath } = policyFiles()
    writeFileSync(userPath, JSON.stringify({ allowedProviders: ['deepgram-nova3'] }))
    writeFileSync(adminPath, JSON.stringify({}))

    expect(
      await readManagedSpeechProviders(userPath, adminPath, () => {
        throw new Error('synthetic trust failure')
      })
    ).toEqual({ state: 'invalid' })
  })

  it('parses bytes returned by the trusted callback for the exact existing admin path', async () => {
    const { userPath, adminPath } = policyFiles()
    writeFileSync(adminPath, JSON.stringify({ allowedProviders: ['cloudflare-nova3'] }))
    const trustedBytes = Buffer.from(readFileSync(adminPath))
    const readTrustedAdminBytes = vi.fn((path: string) => (path === adminPath ? trustedBytes : null))

    expect(await readManagedSpeechProviders(userPath, adminPath, readTrustedAdminBytes)).toEqual({
      state: 'valid',
      providers: ['cloudflare-nova3']
    })
  })
})

describe('readManagedSpeechPolicy', () => {
  it('resolves provider and egress keys independently with admin precedence and explicit empty deny', async () => {
    const { userPath, adminPath } = policyFiles()
    writeFileSync(
      userPath,
      JSON.stringify({
        allowedProviders: ['deepgram-nova3'],
        egressAllowlist: ['operator.example', '*.speech.example']
      })
    )
    writeFileSync(adminPath, JSON.stringify({ allowedProviders: [], lockedKeys: ['provider'] }))
    const readTrustedAdminBytes = vi.fn((path: string) => readFileSync(path))

    expect(await readManagedSpeechPolicy(userPath, adminPath, readTrustedAdminBytes)).toEqual({
      state: 'valid',
      providers: { state: 'valid', providers: [] },
      egressAllowlist: ['operator.example', '*.speech.example']
    })
    expect(readTrustedAdminBytes).toHaveBeenCalledTimes(1)
    expect(readTrustedAdminBytes).toHaveBeenCalledWith(adminPath)
  })

  it('distinguishes absent policy from explicit deny-all', async () => {
    const { userPath, adminPath } = policyFiles()
    writeFileSync(userPath, JSON.stringify({ lockedKeys: [] }))
    expect(await readManagedSpeechPolicy(userPath, adminPath, () => null)).toEqual({ state: 'absent' })

    writeFileSync(adminPath, JSON.stringify({ egressAllowlist: [] }))
    expect(await readManagedSpeechPolicy(userPath, adminPath, (path) => readFileSync(path))).toEqual({
      state: 'valid',
      providers: { state: 'absent' },
      egressAllowlist: []
    })
  })

  it('fails closed for a malformed present egress key instead of widening it to unrestricted', async () => {
    const { userPath, adminPath } = policyFiles()
    writeFileSync(userPath, JSON.stringify({ allowedProviders: ['deepgram-nova3'], egressAllowlist: ['ok.example'] }))
    writeFileSync(adminPath, JSON.stringify({ egressAllowlist: ['valid.example', 5] }))

    expect(await readManagedSpeechPolicy(userPath, adminPath, (path) => readFileSync(path))).toEqual({
      state: 'invalid'
    })
    // The legacy API remains provider-only and keeps its historical result contract.
    expect(await readManagedSpeechProviders(userPath, adminPath, (path) => readFileSync(path))).toEqual({
      state: 'valid',
      providers: ['deepgram-nova3']
    })
  })

  it('treats an explicit admin egress list as overriding the user key, including empty deny', async () => {
    const { userPath, adminPath } = policyFiles()
    writeFileSync(userPath, JSON.stringify({ egressAllowlist: ['user.example'] }))
    writeFileSync(adminPath, JSON.stringify({ egressAllowlist: [] }))
    expect(await readManagedSpeechPolicy(userPath, adminPath, (path) => readFileSync(path))).toEqual({
      state: 'valid',
      providers: { state: 'absent' },
      egressAllowlist: []
    })
  })
})
