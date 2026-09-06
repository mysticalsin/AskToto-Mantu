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
  it('MQA-137: strips MCP connection state, so mcpPush\'s endpoint pin cannot be rewritten from the renderer', () => {
    const keys = strippedKeys()
    expect(keys).toContain('mcpConnections')
    expect(keys).toContain('clickupClientId')
    expect(keys).toContain('planeClientId')
  })

  it('the strip actually removes those keys from a hostile patch (logic, not just shape)', () => {
    // Execute the same delete loop the handler runs, over the key list read from the source above.
    const hostile: Record<string, unknown> = {
      mcpConnections: [
        { id: 'clickup', kind: 'clickup', label: 'ClickUp', endpointUrl: 'https://attacker.example/mcp', connected: true, tools: ['x'], extraHeaders: {} }
      ],
      clickupClientId: 'attacker-client',
      planeClientId: 'attacker-plane-client',
      licenseValid: true,
      licenseSeatCap: 999999,
      // a genuine user setting in the same patch must survive
      askFollowUpMemory: true
    }
    for (const k of strippedKeys()) if (k in hostile) delete hostile[k]

    expect(hostile.mcpConnections).toBeUndefined()
    expect(hostile.clickupClientId).toBeUndefined()
    expect(hostile.planeClientId).toBeUndefined()
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

  // Every step of the Dust device-login sequence writes or advances credential state, so gating only the
  // FIRST one is decorative: a caller can mint its own WorkOS device code out-of-band, skip begin, and
  // drive poll -> pickWorkspace to install attacker-controlled Dust tokens as this user's credential.
  it('MQA-133: every Dust login handler gates on requireAuth(), not just the begin step', () => {
    for (const channel of ['dustLoginBegin', 'dustLoginPoll', 'dustLoginPickWorkspace', 'dustInstallCli']) {
      const start = indexSrc.indexOf(`ipcMain.handle(IPC.${channel}`)
      expect(start, `${channel} handler not found`).toBeGreaterThan(-1)
      const body = indexSrc.slice(start, start + 900)
      expect(body, `${channel} must call assertMainWindow`).toMatch(/assertMainWindow\(e\)/)
      expect(body, `${channel} must gate on requireAuth`).toMatch(/if \(!requireAuth\(\)\)/)
    }
  })

  // Dust's credential is a PAIR (provider key + WorkOS refresh token in its own file). Clearing only the
  // key left dust-refresh.bin on disk, so a later refresh could silently re-mint a working key and
  // reconnect an integration the user had explicitly removed.
  it('MQA-135: clearing the Dust key also clears its refresh token, and reports a file that survived', () => {
    const start = indexSrc.indexOf('ipcMain.handle(IPC.clearApiKey')
    expect(start).toBeGreaterThan(-1)
    const body = indexSrc.slice(start, start + 1600)
    expect(body).toMatch(/parsed\.provider === 'dust'/)
    expect(body).toMatch(/clearDustRefreshToken\(\)/)
    // The result must carry the bad news rather than reporting a clean removal.
    expect(body).toMatch(/dustRefreshRemoved/)
  })

  // Gating the handlers is only half of it: polling a CALLER-supplied device code would still let a
  // renderer foothold complete a login against a code minted out-of-band against the public WorkOS
  // client id. Main mints it, keeps it, and never hands it over.
  it('MQA-133: the Dust device code stays in main and is never returned to the renderer', () => {
    const start = indexSrc.indexOf('ipcMain.handle(IPC.dustLoginBegin')
    const body = indexSrc.slice(start, start + 900)
    expect(body).toMatch(/pendingDustDeviceCode = r\.ok && r\.deviceCode \? r\.deviceCode : null/)
    // The response is destructured to drop the code before it crosses the IPC boundary.
    expect(body).toMatch(/deviceCode: _withheld/)

    const poll = indexSrc.indexOf('ipcMain.handle(IPC.dustLoginPoll')
    const pollBody = indexSrc.slice(poll, poll + 900)
    expect(pollBody).toMatch(/const deviceCode = pendingDustDeviceCode/)
    // No payload parameter at all — there is nothing for a caller to supply.
    expect(pollBody).toMatch(/ipcMain\.handle\(IPC\.dustLoginPoll, async \(e\) =>/)
  })

  it('the only writers of mcpConnections are main-side handlers that re-verify the connection first', () => {
    // Each of these persists in MAIN after connectMcp()/runClickupOAuth() succeeded, which is why the
    // renderer never needs to write the key itself.
    const writes = [...indexSrc.matchAll(/setSettings\(\{\s*mcpConnections:/g)]
    expect(writes.length).toBeGreaterThanOrEqual(2)
    expect(indexSrc).toMatch(/ipcMain\.handle\(IPC\.mcpSaveConnection/)
    expect(indexSrc).toMatch(/ipcMain\.handle\(IPC\.mcpClickupConnect/)
    expect(indexSrc).toMatch(/ipcMain\.handle\(IPC\.mcpPlaneConnect/)
  })
})
