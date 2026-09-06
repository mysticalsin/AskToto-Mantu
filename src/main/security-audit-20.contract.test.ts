import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repo = join(__dirname, '../..')

function read(rel: string): string {
  return readFileSync(join(repo, rel), 'utf8')
}

describe('AUDIT-20 — HTTP security headers land on the real surfaces', () => {
  it('license-server Express applies nosniff, frame-deny, and HSTS-on-HTTPS', () => {
    const src = read('license-server/lib/app.mjs')
    expect(src).toMatch(/function securityHeaders\(/)
    expect(src).toMatch(/app\.use\(securityHeaders\)/)
    expect(src).toMatch(/X-Content-Type-Options['"], 'nosniff'/)
    expect(src).toMatch(/X-Frame-Options['"], 'DENY'/)
    expect(src).toMatch(/Strict-Transport-Security/)
    expect(src).toMatch(/requestIsHttps\(/)
  })

  it('Caddy TLS site sets the same three headers', () => {
    const caddy = read('license-server/deploy/Caddyfile')
    expect(caddy).toMatch(/X-Content-Type-Options nosniff/)
    expect(caddy).toMatch(/X-Frame-Options DENY/)
    expect(caddy).toMatch(/Strict-Transport-Security/)
  })

  it('Worker jsonResponse and the streamed upstream Response share securityHeaders()', () => {
    const src = read('cloudflare-proxy/src/index.ts')
    expect(src).toMatch(/function securityHeaders\(/)
    expect(src).toMatch(/'x-content-type-options': 'nosniff'/)
    expect(src).toMatch(/'x-frame-options': 'DENY'/)
    expect(src).toMatch(/strict-transport-security/)
    expect(src).toMatch(/headers: securityHeaders\(\{/)
    const json = src.indexOf('function jsonResponse')
    const stream = src.indexOf('return new Response(upstream.body')
    expect(src.slice(json, json + 400)).toContain('securityHeaders(')
    expect(src.slice(stream, stream + 400)).toContain('securityHeaders(')
  })

  it('does not fake this control by stamping HSTS onto overlay HTML', () => {
    const overlay = read('src/renderer/index.html')
    expect(overlay).toMatch(/http-equiv="Content-Security-Policy"/)
    expect(overlay).not.toMatch(/Strict-Transport-Security/)
  })
})

describe('AUDIT-20 — capture/ASR stay takeHotPath, never denyIfLimited', () => {
  it('the live path still cannot block on the outbound limiter', () => {
    const index = read('src/main/index.ts')
    for (const marker of [
      "takeHotPath('asr-feed')",
      "takeHotPath('capture-screen')",
      "takeHotPath('arm-audio')",
      "takeHotPath('save-transcript')"
    ]) {
      expect(index).toContain(marker)
    }
    const capture = index.slice(index.indexOf("ipcMain.handle(IPC.captureScreen"), index.indexOf("ipcMain.handle(IPC.captureScreen") + 800)
    expect(capture).not.toMatch(/denyIfLimited/)
  })
})
