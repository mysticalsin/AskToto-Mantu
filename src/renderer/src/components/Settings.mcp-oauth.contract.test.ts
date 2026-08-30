import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Plug-and-play MCP connect standard: hosted integrations (ClickUp, Plane) are one button → browser
 * login → Connected. No endpoint/key/slug forms on those cards. BidStack stays key-based (local CRM).
 */
const settingsSrc = readFileSync(join(__dirname, 'Settings.tsx'), 'utf8')
const preloadSrc = readFileSync(join(__dirname, '../../../preload/index.ts'), 'utf8')

describe('MCP plug-and-play connect UX', () => {
  it('exposes one-click Plane and ClickUp connect IPC on the preload bridge', () => {
    expect(preloadSrc).toMatch(/mcpClickupConnect:/)
    expect(preloadSrc).toMatch(/mcpPlaneConnect:/)
  })

  it('Plane Settings card uses browser OAuth, not the API-key / workspace-slug form', () => {
    expect(settingsSrc).toMatch(/McpBrowserConnectCard/)
    expect(settingsSrc).toMatch(/mcpPlaneConnect\(\)/)
    expect(settingsSrc).toMatch(/Opens a browser tab to sign in/)
    // Old PAT form must not be the Plane primary path anymore.
    const planeSection = settingsSrc.slice(settingsSrc.indexOf('title="Plane"'), settingsSrc.indexOf('title="ClickUp"'))
    expect(planeSection).not.toMatch(/X-Workspace-slug/)
    expect(planeSection).not.toMatch(/api-key\/mcp/)
    expect(planeSection).toMatch(/Connect Plane|connectLabel="Plane"/)
  })

  it('ClickUp stays on the same one-click browser connect path', () => {
    expect(settingsSrc).toMatch(/mcpClickupConnect\(\)/)
  })
})
