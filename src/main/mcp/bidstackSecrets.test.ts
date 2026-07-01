import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'

vi.mock('electron')

// bidstackSecrets.ts caches the key in-module (like store.ts's _apiKeyCache), so each test resets the
// module registry to get a clean cache bound to a fresh userData dir.
const mockGetPath = app.getPath as ReturnType<typeof vi.fn>

describe('bidstackSecrets — BidStack CRM API key storage (kept out of the ProviderId union)', () => {
  let userData: string

  beforeEach(async () => {
    vi.resetModules()
    userData = mkdtempSync(join(tmpdir(), 'asktoto-bidstack-secrets-test-'))
    const electron = await import('electron')
    ;(electron.app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'userData' ? userData : join(userData, name)
    )
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('has no key by default', async () => {
    const { hasBidstackApiKey, getBidstackApiKey } = await import('./bidstackSecrets')
    expect(hasBidstackApiKey()).toBe(false)
    expect(getBidstackApiKey()).toBe('')
  })

  it('round-trips a saved key', async () => {
    const { setBidstackApiKey, getBidstackApiKey, hasBidstackApiKey } = await import('./bidstackSecrets')
    setBidstackApiKey('bidstack-sk-abc123')
    expect(hasBidstackApiKey()).toBe(true)
    expect(getBidstackApiKey()).toBe('bidstack-sk-abc123')
  })

  it('trims whitespace on save', async () => {
    const { setBidstackApiKey, getBidstackApiKey } = await import('./bidstackSecrets')
    setBidstackApiKey('  bidstack-sk-xyz  ')
    expect(getBidstackApiKey()).toBe('bidstack-sk-xyz')
  })

  it('setting an empty key clears any saved key', async () => {
    const { setBidstackApiKey, getBidstackApiKey, hasBidstackApiKey } = await import('./bidstackSecrets')
    setBidstackApiKey('something')
    setBidstackApiKey('')
    expect(hasBidstackApiKey()).toBe(false)
    expect(getBidstackApiKey()).toBe('')
  })

  it('clearBidstackApiKey removes the key file and cache', async () => {
    const { setBidstackApiKey, clearBidstackApiKey, hasBidstackApiKey } = await import('./bidstackSecrets')
    setBidstackApiKey('to-be-cleared')
    const p = join(userData, 'key-bidstack.bin')
    expect(existsSync(p)).toBe(true)
    clearBidstackApiKey()
    expect(existsSync(p)).toBe(false)
    expect(hasBidstackApiKey()).toBe(false)
  })

  it('persists to its own dedicated file, never touching the provider key files', async () => {
    const { setBidstackApiKey } = await import('./bidstackSecrets')
    setBidstackApiKey('persisted-key')
    expect(existsSync(join(userData, 'key-bidstack.bin'))).toBe(true)
    expect(existsSync(join(userData, 'key-anthropic.bin'))).toBe(false)
  })

  it('a fresh module load re-reads the persisted key from disk (survives process restart)', async () => {
    const first = await import('./bidstackSecrets')
    first.setBidstackApiKey('reloaded-key')

    vi.resetModules()
    const electron = await import('electron')
    ;(electron.app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'userData' ? userData : join(userData, name)
    )
    const second = await import('./bidstackSecrets')
    expect(second.getBidstackApiKey()).toBe('reloaded-key')
  })
})
