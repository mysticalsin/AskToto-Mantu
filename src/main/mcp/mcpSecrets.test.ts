import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'

vi.mock('electron')

// mcpSecrets.ts caches keys in-module (like store.ts's _apiKeyCache), so each test resets the module
// registry to get a clean cache bound to a fresh userData dir.
const mockGetPath = app.getPath as ReturnType<typeof vi.fn>

describe('mcpSecrets — MCP connection API key storage, keyed by connectionId', () => {
  let userData: string

  beforeEach(async () => {
    vi.resetModules()
    userData = mkdtempSync(join(tmpdir(), 'asktoto-mcp-secrets-test-'))
    const electron = await import('electron')
    ;(electron.app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'userData' ? userData : join(userData, name)
    )
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

  it('has no key by default', async () => {
    const { hasMcpApiKey, getMcpApiKey } = await import('./mcpSecrets')
    expect(hasMcpApiKey('bidstack')).toBe(false)
    expect(getMcpApiKey('bidstack')).toBe('')
  })

  it('round-trips a saved key', async () => {
    const { setMcpApiKey, getMcpApiKey, hasMcpApiKey } = await import('./mcpSecrets')
    setMcpApiKey('bidstack', 'bidstack-sk-abc123')
    expect(hasMcpApiKey('bidstack')).toBe(true)
    expect(getMcpApiKey('bidstack')).toBe('bidstack-sk-abc123')
  })

  it('trims whitespace on save', async () => {
    const { setMcpApiKey, getMcpApiKey } = await import('./mcpSecrets')
    setMcpApiKey('bidstack', '  bidstack-sk-xyz  ')
    expect(getMcpApiKey('bidstack')).toBe('bidstack-sk-xyz')
  })

  it('setting an empty key clears any saved key', async () => {
    const { setMcpApiKey, getMcpApiKey, hasMcpApiKey } = await import('./mcpSecrets')
    setMcpApiKey('bidstack', 'something')
    setMcpApiKey('bidstack', '')
    expect(hasMcpApiKey('bidstack')).toBe(false)
    expect(getMcpApiKey('bidstack')).toBe('')
  })

  it('clearMcpApiKey removes the key file and cache', async () => {
    const { setMcpApiKey, clearMcpApiKey, hasMcpApiKey } = await import('./mcpSecrets')
    setMcpApiKey('bidstack', 'to-be-cleared')
    const p = join(userData, 'key-mcp-bidstack.bin')
    expect(existsSync(p)).toBe(true)
    clearMcpApiKey('bidstack')
    expect(existsSync(p)).toBe(false)
    expect(hasMcpApiKey('bidstack')).toBe(false)
  })

  it('persists to its own dedicated per-connection file, never touching the provider key files', async () => {
    const { setMcpApiKey } = await import('./mcpSecrets')
    setMcpApiKey('bidstack', 'persisted-key')
    expect(existsSync(join(userData, 'key-mcp-bidstack.bin'))).toBe(true)
    expect(existsSync(join(userData, 'key-anthropic.bin'))).toBe(false)
  })

  it('a fresh module load re-reads the persisted key from disk (survives process restart)', async () => {
    const first = await import('./mcpSecrets')
    first.setMcpApiKey('bidstack', 'reloaded-key')

    vi.resetModules()
    const electron = await import('electron')
    ;(electron.app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
      name === 'userData' ? userData : join(userData, name)
    )
    const second = await import('./mcpSecrets')
    expect(second.getMcpApiKey('bidstack')).toBe('reloaded-key')
  })

  it('two different connectionIds are stored independently', async () => {
    const { setMcpApiKey, getMcpApiKey } = await import('./mcpSecrets')
    setMcpApiKey('bidstack', 'bidstack-key')
    setMcpApiKey('plane', 'plane-key')
    expect(getMcpApiKey('bidstack')).toBe('bidstack-key')
    expect(getMcpApiKey('plane')).toBe('plane-key')
    expect(existsSync(join(userData, 'key-mcp-bidstack.bin'))).toBe(true)
    expect(existsSync(join(userData, 'key-mcp-plane.bin'))).toBe(true)
  })

  describe('legacy key-bidstack.bin fallback (pre-generalization users)', () => {
    it("falls back to the legacy file when key-mcp-bidstack.bin doesn't exist yet", async () => {
      // Write a legacy-shaped blob using the SAME AES-GCM file backend mcpSecrets.ts uses, under the old
      // marker/filename — reproduces exactly what a pre-generalization install left on disk.
      const { encryptSecret } = await import('../secrets')
      const legacyBlob = Buffer.concat([Buffer.from('ATKBID1\n'), encryptSecret('legacy-bidstack-key')])
      writeFileSync(join(userData, 'key-bidstack.bin'), legacyBlob)

      const { getMcpApiKey, hasMcpApiKey } = await import('./mcpSecrets')
      expect(hasMcpApiKey('bidstack')).toBe(true)
      expect(getMcpApiKey('bidstack')).toBe('legacy-bidstack-key')
    })

    it('a real key-mcp-bidstack.bin always wins over the legacy file', async () => {
      const { encryptSecret } = await import('../secrets')
      const legacyBlob = Buffer.concat([Buffer.from('ATKBID1\n'), encryptSecret('legacy-key')])
      writeFileSync(join(userData, 'key-bidstack.bin'), legacyBlob)

      const { setMcpApiKey, getMcpApiKey } = await import('./mcpSecrets')
      setMcpApiKey('bidstack', 'new-key')
      expect(getMcpApiKey('bidstack')).toBe('new-key')
    })

    it('the legacy fallback never applies to a different connectionId (e.g. plane)', async () => {
      const { encryptSecret } = await import('../secrets')
      const legacyBlob = Buffer.concat([Buffer.from('ATKBID1\n'), encryptSecret('legacy-bidstack-key')])
      writeFileSync(join(userData, 'key-bidstack.bin'), legacyBlob)

      const { getMcpApiKey, hasMcpApiKey } = await import('./mcpSecrets')
      expect(hasMcpApiKey('plane')).toBe(false)
      expect(getMcpApiKey('plane')).toBe('')
    })

    it('disconnecting bidstack removes the legacy file too, so a restart cannot resurrect the cleared key', async () => {
      const { encryptSecret } = await import('../secrets')
      const legacyBlob = Buffer.concat([Buffer.from('ATKBID1\n'), encryptSecret('legacy-bidstack-key')])
      const legacyPath = join(userData, 'key-bidstack.bin')
      writeFileSync(legacyPath, legacyBlob)

      const { clearMcpApiKey } = await import('./mcpSecrets')
      const ok = clearMcpApiKey('bidstack')
      expect(ok).toBe(true)
      expect(existsSync(legacyPath)).toBe(false)

      // Simulate an app restart: fresh module load, no in-memory cache to hide the legacy file.
      vi.resetModules()
      const electron = await import('electron')
      ;(electron.app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
        name === 'userData' ? userData : join(userData, name)
      )
      const reloaded = await import('./mcpSecrets')
      expect(reloaded.hasMcpApiKey('bidstack')).toBe(false)
    })
  })

  describe('refresh-token slot (OAuth connections — ClickUp today)', () => {
    it('has no refresh token by default', async () => {
      const { getMcpRefreshToken } = await import('./mcpSecrets')
      expect(getMcpRefreshToken('clickup')).toBe('')
    })

    it('round-trips a saved refresh token, independent of the main API key file', async () => {
      const { setMcpApiKey, setMcpRefreshToken, getMcpApiKey, getMcpRefreshToken } = await import('./mcpSecrets')
      setMcpApiKey('clickup', 'clickup-access-token')
      setMcpRefreshToken('clickup', 'clickup-refresh-token')
      expect(getMcpApiKey('clickup')).toBe('clickup-access-token')
      expect(getMcpRefreshToken('clickup')).toBe('clickup-refresh-token')
      expect(existsSync(join(userData, 'key-mcp-clickup.bin'))).toBe(true)
      expect(existsSync(join(userData, 'key-mcp-clickup-refresh.bin'))).toBe(true)
    })

    it('setting an empty refresh token clears it', async () => {
      const { setMcpRefreshToken, getMcpRefreshToken } = await import('./mcpSecrets')
      setMcpRefreshToken('clickup', 'something')
      setMcpRefreshToken('clickup', '')
      expect(getMcpRefreshToken('clickup')).toBe('')
    })

    it('clearMcpRefreshToken removes the file and cache, and no-ops cleanly when there is nothing to clear', async () => {
      const { setMcpRefreshToken, clearMcpRefreshToken, getMcpRefreshToken } = await import('./mcpSecrets')
      setMcpRefreshToken('clickup', 'to-be-cleared')
      const p = join(userData, 'key-mcp-clickup-refresh.bin')
      expect(existsSync(p)).toBe(true)
      expect(clearMcpRefreshToken('clickup')).toBe(true)
      expect(existsSync(p)).toBe(false)
      expect(getMcpRefreshToken('clickup')).toBe('')
      // A connection that never had a refresh token (e.g. bidstack, plane) clears as a clean no-op.
      expect(clearMcpRefreshToken('plane')).toBe(true)
    })

    it('a fresh module load re-reads the persisted refresh token from disk', async () => {
      const first = await import('./mcpSecrets')
      first.setMcpRefreshToken('clickup', 'reloaded-refresh-token')

      vi.resetModules()
      const electron = await import('electron')
      ;(electron.app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
        name === 'userData' ? userData : join(userData, name)
      )
      const second = await import('./mcpSecrets')
      expect(second.getMcpRefreshToken('clickup')).toBe('reloaded-refresh-token')
    })
  })
})
