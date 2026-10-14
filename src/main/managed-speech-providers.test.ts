import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readManagedSpeechProviders } from './managed-speech-providers'

const temporaryDirectories: string[] = []

function policyFiles(): { directory: string; userPath: string; adminPath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'managed-speech-providers-'))
  temporaryDirectories.push(directory)
  return { directory, userPath: join(directory, 'user.json'), adminPath: join(directory, 'admin.json') }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('readManagedSpeechProviders', () => {
  it('uses explicit admin restrictions over user policy, including empty deny-all', () => {
    const { userPath, adminPath } = policyFiles()
    writeFileSync(userPath, JSON.stringify({ allowedProviders: ['deepgram-nova3'] }))
    writeFileSync(adminPath, JSON.stringify({ allowedProviders: [] }))
    const readTrustedAdminBytes = vi.fn((path: string) => readFileSync(path))

    expect(readManagedSpeechProviders(userPath, adminPath, readTrustedAdminBytes)).toEqual({
      state: 'valid',
      providers: []
    })
    expect(readTrustedAdminBytes).toHaveBeenCalledWith(adminPath)
  })

  it('falls back to user policy only when the trusted admin file omits the key', () => {
    const { userPath, adminPath } = policyFiles()
    writeFileSync(userPath, JSON.stringify({ allowedProviders: ['deepgram-nova3', 'cloudflare-nova3'] }))
    writeFileSync(adminPath, JSON.stringify({ lockedKeys: ['provider'] }))

    expect(readManagedSpeechProviders(userPath, adminPath, (path) => readFileSync(path))).toEqual({
      state: 'valid',
      providers: ['deepgram-nova3', 'cloudflare-nova3']
    })
  })

  it('fails closed for an existing but untrusted admin policy', () => {
    const { userPath, adminPath } = policyFiles()
    writeFileSync(userPath, JSON.stringify({ allowedProviders: ['deepgram-nova3'] }))
    writeFileSync(adminPath, JSON.stringify({ allowedProviders: ['cloudflare-nova3'] }))

    expect(readManagedSpeechProviders(userPath, adminPath, () => null)).toEqual({ state: 'invalid' })
  })

  it('uses user policy when admin file is absent and reports absent when neither has the key', () => {
    const { userPath, adminPath } = policyFiles()
    writeFileSync(userPath, JSON.stringify({ allowedProviders: ['deepgram-nova3'] }))
    expect(readManagedSpeechProviders(userPath, adminPath, () => null)).toEqual({
      state: 'valid',
      providers: ['deepgram-nova3']
    })
    writeFileSync(userPath, JSON.stringify({ lockedKeys: [] }))
    expect(readManagedSpeechProviders(userPath, adminPath, () => null)).toEqual({ state: 'absent' })
  })

  it('treats malformed JSON, non-array values, and nonstring entries as invalid', () => {
    const { userPath, adminPath } = policyFiles()
    for (const content of ['{', '{"allowedProviders":{}}', '{"allowedProviders":["deepgram-nova3",2]}', 'null']) {
      writeFileSync(userPath, content)
      expect(readManagedSpeechProviders(userPath, adminPath, () => null)).toEqual({ state: 'invalid' })
    }
  })

  it('rejects symlinks, nonregular files, and files larger than the fixed byte cap', () => {
    const { directory, userPath, adminPath } = policyFiles()
    const target = join(directory, 'target.json')
    writeFileSync(target, JSON.stringify({ allowedProviders: ['deepgram-nova3'] }))
    symlinkSync(target, userPath)
    expect(readManagedSpeechProviders(userPath, adminPath, () => null)).toEqual({ state: 'invalid' })

    expect(readManagedSpeechProviders(directory, adminPath, () => null)).toEqual({ state: 'invalid' })
    writeFileSync(userPath, Buffer.alloc(1_048_577, 0x20))
    expect(readManagedSpeechProviders(userPath, adminPath, () => null)).toEqual({ state: 'invalid' })
  })

  it('rejects an admin symlink before asking the trusted reader for content', () => {
    const { userPath, adminPath, directory } = policyFiles()
    const target = join(directory, 'target.json')
    writeFileSync(target, JSON.stringify({ allowedProviders: ['deepgram-nova3'] }))
    symlinkSync(target, adminPath)
    const readTrustedAdminBytes = vi.fn(() => null)

    expect(readManagedSpeechProviders(userPath, adminPath, readTrustedAdminBytes)).toEqual({ state: 'invalid' })
    expect(readTrustedAdminBytes).not.toHaveBeenCalled()
  })

  it('treats a trusted admin reader failure as invalid rather than falling back', () => {
    const { userPath, adminPath } = policyFiles()
    writeFileSync(userPath, JSON.stringify({ allowedProviders: ['deepgram-nova3'] }))
    writeFileSync(adminPath, JSON.stringify({}))

    expect(
      readManagedSpeechProviders(userPath, adminPath, () => {
        throw new Error('synthetic trust failure')
      })
    ).toEqual({ state: 'invalid' })
  })

  it('parses bytes returned by the trusted callback for the exact existing admin path', () => {
    const { userPath, adminPath } = policyFiles()
    writeFileSync(adminPath, JSON.stringify({ allowedProviders: ['cloudflare-nova3'] }))
    const trustedBytes = Buffer.from(readFileSync(adminPath))
    const readTrustedAdminBytes = vi.fn((path: string) => (path === adminPath ? trustedBytes : null))

    expect(readManagedSpeechProviders(userPath, adminPath, readTrustedAdminBytes)).toEqual({
      state: 'valid',
      providers: ['cloudflare-nova3']
    })
  })
})
