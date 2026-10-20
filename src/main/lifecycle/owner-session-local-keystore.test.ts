import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const qaIdentityDir = join('/synthetic/qa-profile', 'identity')
const qaSaltPath = join(qaIdentityDir, 'owner-key-salt.v1')

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true, getPath: vi.fn(() => '/synthetic/qa-profile') },
  safeStorage: {
    isEncryptionAvailable: vi.fn(),
    encryptString: vi.fn(),
    decryptString: vi.fn()
  },
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn()
}))
vi.mock('electron', () => ({
  app: mocks.app,
  safeStorage: mocks.safeStorage,
  webContents: { fromFrame: () => ({ id: 1 }) }
}))
vi.mock('node:fs/promises', () => ({
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  mkdir: mocks.mkdir,
  rename: mocks.rename
}))
vi.mock('../auth', () => ({
  authSessionGeneration: () => 1,
  authStatus: () => ({ signedIn: true, email: 'qa@example.invalid' })
}))

import { createMainOwnerSessionAuthority } from './owner-session-authority'

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('ASKTOTO_LOCAL_KEYSTORE', '')
  mocks.app.isPackaged = true
  mocks.app.getPath.mockReturnValue('/synthetic/qa-profile')
  mocks.readFile.mockResolvedValue(Buffer.alloc(32, 7))
  mocks.safeStorage.isEncryptionAvailable.mockReturnValue(true)
  mocks.safeStorage.decryptString.mockReturnValue(Buffer.alloc(32, 7).toString('base64'))
})
afterEach(() => vi.unstubAllEnvs())

describe('owner-session salt backend selection', () => {
  it('creates a private local salt without platform encryption in a fresh QA profile', async () => {
    vi.stubEnv('ASKTOTO_LOCAL_KEYSTORE', '1')
    mocks.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    const authority = createMainOwnerSessionAuthority(() => 0)
    await vi.waitFor(() => expect(authority.mint({ processId: 1, routingId: 2 }, 0)).not.toBeNull())
    const [temporaryPath, bytes, mode] = mocks.writeFile.mock.calls[0]
    expect(dirname(temporaryPath)).toBe(qaIdentityDir)
    expect(basename(temporaryPath)).toMatch(/^owner-key-salt\.v1\.tmp-[a-f0-9]+$/)
    expect(bytes).toBeInstanceOf(Buffer)
    expect(bytes).toHaveLength(32)
    expect(mode).toEqual({ mode: 0o600 })
    expect(mocks.mkdir).toHaveBeenCalledWith(qaIdentityDir, { recursive: true, mode: 0o700 })
    expect(mocks.rename).toHaveBeenCalledWith(temporaryPath, qaSaltPath)
    expect(mocks.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(mocks.safeStorage.encryptString).not.toHaveBeenCalled()
    expect(mocks.safeStorage.decryptString).not.toHaveBeenCalled()
  })

  it('never probes or uses platform credentials when the local keystore is forced', async () => {
    vi.stubEnv('ASKTOTO_LOCAL_KEYSTORE', '1')
    mocks.safeStorage.isEncryptionAvailable.mockImplementation(() => {
      throw new Error('platform credential access forbidden')
    })
    const authority = createMainOwnerSessionAuthority(() => 0)
    await vi.waitFor(() => expect(authority.mint({ processId: 1, routingId: 2 }, 0)).not.toBeNull())
    expect(mocks.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(mocks.safeStorage.decryptString).not.toHaveBeenCalled()
    expect(mocks.safeStorage.encryptString).not.toHaveBeenCalled()
    expect(mocks.readFile).toHaveBeenCalledWith(qaSaltPath)
  })

  it('retains wrapped salt use for a packaged app without the local override', async () => {
    const authority = createMainOwnerSessionAuthority(() => 0)
    await vi.waitFor(() => expect(authority.mint({ processId: 1, routingId: 2 }, 0)).not.toBeNull())
    expect(mocks.safeStorage.isEncryptionAvailable).toHaveBeenCalledOnce()
    expect(mocks.safeStorage.decryptString).toHaveBeenCalledOnce()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it('keeps unpackaged runs independent of platform credentials', async () => {
    mocks.app.isPackaged = false
    const authority = createMainOwnerSessionAuthority(() => 0)
    await vi.waitFor(() => expect(authority.mint({ processId: 1, routingId: 2 }, 0)).not.toBeNull())
    expect(mocks.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(mocks.safeStorage.decryptString).not.toHaveBeenCalled()
  })

  it('fails closed without overwriting an unreadable salt under the local override', async () => {
    vi.stubEnv('ASKTOTO_LOCAL_KEYSTORE', '1')
    mocks.readFile.mockResolvedValue(Buffer.from('unreadable wrapped salt'))
    const authority = createMainOwnerSessionAuthority(() => 0)
    await Promise.resolve()
    await Promise.resolve()
    expect(authority.mint({ processId: 1, routingId: 2 }, 0)).toBeNull()
    expect(mocks.safeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(mocks.safeStorage.decryptString).not.toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
    expect(mocks.rename).not.toHaveBeenCalled()
  })
})
