import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { clearSonioxApiKey, getSonioxApiKeyStored, setSonioxApiKey } from './store'

vi.mock('electron')

// Simulate the locked-file shape produced by Windows AV/backup software without changing permissions
// on the real filesystem. Only the Soniox key's unlink is denied; all other profile I/O stays real.
const fsGate = vi.hoisted(() => ({ denySonioxDelete: false }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const unlinkSync = (...args: Parameters<typeof actual.unlinkSync>): void => {
    const [path] = args
    if (fsGate.denySonioxDelete && typeof path === 'string' && path.endsWith('key-soniox.bin')) {
      const error = new Error(`EPERM: operation not permitted, unlink '${path}'`) as NodeJS.ErrnoException
      error.code = 'EPERM'
      error.syscall = 'unlink'
      error.path = path
      throw error
    }
    actual.unlinkSync(...args)
  }
  return { ...actual, unlinkSync }
})

const mockAppGetPath = app.getPath as ReturnType<typeof vi.fn>

describe('Soniox encrypted key removal', () => {
  let userData: string

  beforeEach(() => {
    fsGate.denySonioxDelete = false
    userData = mkdtempSync(join(tmpdir(), 'asktoto-soniox-clear-'))
    mockAppGetPath.mockImplementation((name: string) => (name === 'userData' ? userData : join(userData, name)))
  })

  afterEach(() => {
    fsGate.denySonioxDelete = false
    rmSync(userData, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('fails visibly and reloads the real encrypted key when its delete is denied', () => {
    const key = 'soniox-test-key'
    const path = join(userData, 'key-soniox.bin')
    setSonioxApiKey(key)
    expect(getSonioxApiKeyStored()).toBe(key)

    fsGate.denySonioxDelete = true

    let failure: unknown
    try {
      clearSonioxApiKey()
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/couldn't remove your Soniox key/i)
    expect((failure as Error).message).not.toContain(path)
    expect((failure as Error).message).not.toContain(key)
    expect(existsSync(path)).toBe(true)
    // A failed delete must never turn the live session into an imaginary "no key" state.
    expect(getSonioxApiKeyStored()).toBe(key)
  })
})
