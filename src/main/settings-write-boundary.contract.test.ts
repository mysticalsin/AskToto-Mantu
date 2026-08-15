import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BaseSettingsSchema } from '@shared/ipc'

/**
 * The settings:set write boundary. src/main/index.ts boots Electron at import time and this seam is a
 * closure inside an ipcMain handler, so there is no index.test.ts — the established pattern
 * (pinned-agent-boundary.contract.test.ts, ask-freshness.contract.test.ts) pins the invariant against
 * the actual source. Where the fix is a self-contained expression, the expression is lifted out of the
 * source and EXECUTED here, so the assertion tests the shipped logic rather than its shape.
 *
 * The invariant: some settings are main-owned. The renderer may hold them in its snapshot and render
 * them, but it may never WRITE them through the generic settings patch, because another handler's
 * security guarantee is derived from them.
 */
const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')

/** Pull every key list that the settings:set handler strips from an incoming renderer patch. */
function strippedKeys(): string[] {
  const start = indexSrc.indexOf('const p = patch ?? {}')
  expect(start).toBeGreaterThan(-1)
  const region = indexSrc.slice(start, start + 3000)
  const keys: string[] = []
  for (const m of region.matchAll(/for \(const k of \[([^\]]+)\]\) \{\s*\n\s*if \(k in p\) delete \(p as Record<string, unknown>\)\[k\]/g)) {
    for (const raw of m[1].split(',')) {
      const key = raw.trim().replace(/^['"]|['"]$/g, '')
      if (key) keys.push(key)
    }
  }
  return keys
}

describe('settings:set — main-owned keys are not renderer-writable', () => {
  it('strips the server-authoritative license state (self-issued license)', () => {
    const keys = strippedKeys()
    for (const k of ['licenseKey', 'licenseValid', 'licenseSeatCap', 'licenseExpiresAt', 'licenseLastValidatedAt']) {
      expect(keys, `settings:set must strip ${k}`).toContain(k)
    }
  })

  // The real exfiltration path this closes: IPC.mcpPush deliberately reads the endpoint from SAVED
  // settings instead of the payload, so that "a compromised renderer can't redirect the push to an
  // attacker-controlled MCP endpoint". A generic settings patch that could rewrite
  // mcpConnections[].endpointUrl defeats that pin and ships the stored bearer token (a BidStack/Plane
  // key, or a ClickUp OAuth access token) to any host that passes the SSRF guard.
  it('strips MCP connection state, so mcpPush\'s endpoint pin cannot be rewritten from the renderer', () => {
    const keys = strippedKeys()
    expect(keys).toContain('mcpConnections')
    expect(keys).toContain('clickupClientId')
  })

  it('the strip actually removes those keys from a hostile patch (logic, not just shape)', () => {
    // Execute the same delete loop the handler runs, over the key list read from the source above.
    const hostile: Record<string, unknown> = {
      mcpConnections: [
        { id: 'clickup', kind: 'clickup', label: 'ClickUp', endpointUrl: 'https://attacker.example/mcp', connected: true, tools: ['x'], extraHeaders: {} }
      ],
      clickupClientId: 'attacker-client',
      licenseValid: true,
      licenseSeatCap: 999999,
      // a genuine user setting in the same patch must survive
      askFollowUpMemory: true
    }
    for (const k of strippedKeys()) if (k in hostile) delete hostile[k]

    expect(hostile.mcpConnections).toBeUndefined()
    expect(hostile.clickupClientId).toBeUndefined()
    expect(hostile.licenseValid).toBeUndefined()
    expect(hostile.licenseSeatCap).toBeUndefined()
    expect(hostile.askFollowUpMemory).toBe(true)
  })

  it('every stripped key is a real settings field (the list cannot rot into no-ops)', () => {
    const shape = BaseSettingsSchema.shape as Record<string, unknown>
    for (const k of strippedKeys()) {
      expect(shape[k], `${k} is stripped but is not a BaseSettingsSchema field`).toBeDefined()
    }
  })

  it('the only writers of mcpConnections are main-side handlers that re-verify the connection first', () => {
    // Each of these persists in MAIN after connectMcp()/runClickupOAuth() succeeded, which is why the
    // renderer never needs to write the key itself.
    const writes = [...indexSrc.matchAll(/setSettings\(\{\s*mcpConnections:/g)]
    expect(writes.length).toBeGreaterThanOrEqual(2)
    expect(indexSrc).toMatch(/ipcMain\.handle\(IPC\.mcpSaveConnection/)
    expect(indexSrc).toMatch(/ipcMain\.handle\(IPC\.mcpClickupConnect/)
  })
})
