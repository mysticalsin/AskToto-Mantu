import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'smoke-import.mjs'), 'utf8')
const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

describe('import smoke isolation', () => {
  it('routes saved meetings into the temporary smoke profile before importing', () => {
    const configure = source.indexOf('window.toto.setSettings({ meetingsFolder:')
    const importStart = source.indexOf('window.toto.importAudioPick()')
    expect(configure).toBeGreaterThan(-1)
    expect(importStart).toBeGreaterThan(-1)
    expect(configure).toBeLessThan(importStart)
  })

  it('provisions the explicitly required ASR payload before the smoke build, without changing normal builds', () => {
    expect(packageJson.scripts['test:smoke:import']).toBe(
      'npm run fetch-models && npm run build && node scripts/smoke-import.mjs'
    )
    expect(packageJson.scripts.build).not.toMatch(/fetch-models/)
  })

  it('bounds a Playwright window-attachment failure independently of Playwright event timeouts', () => {
    expect(source).toContain('const FIRST_WINDOW_TIMEOUT_MS = 30_000')
    expect(source).toContain('async function waitForFirstWindow()')
    const waitStart = source.indexOf('async function waitForFirstWindow()')
    const waitEnd = source.indexOf('\ntry {', waitStart)
    const wait = source.slice(waitStart, waitEnd)
    expect(wait).toContain('app.firstWindow({ timeout: FIRST_WINDOW_TIMEOUT_MS })')
    expect(wait).toContain('withTimeout(')
    const helperStart = source.indexOf('function withTimeout(operation, timeoutMs, message)')
    const helperEnd = source.indexOf('\nfunction watchPage', helperStart)
    const helper = source.slice(helperStart, helperEnd)
    expect(helper).toContain('Promise.race([operation, timeout])')
    expect(helper).toContain('setTimeout(')
    expect(helper).toContain('clearTimeout(timer)')
    expect(source).toContain('page = await waitForFirstWindow()')
  })
})
