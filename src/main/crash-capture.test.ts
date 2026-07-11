import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Source-contract test for LOCAL-ONLY native crash capture (same structural-proof pattern as
 * local-routing.test.ts). A native Chromium CHECK crash has no app frames, so nothing else in the
 * process can observe it — crashReporter.start must run at module scope (before app ready) and must
 * never enable uploads (zero-telemetry design).
 */
describe('native crash capture (local-only)', () => {
  const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')

  it('starts the crash reporter with uploads disabled', () => {
    expect(source).toMatch(/crashReporter\.start\(\{ uploadToServer: false \}\)/)
  })

  it('never configures a submit URL (nothing may leave the device)', () => {
    expect(source).not.toMatch(/submitURL/)
  })

  it('runs before app ready (module scope, ahead of the first appendSwitch)', () => {
    const start = source.indexOf('crashReporter.start')
    const firstSwitch = source.indexOf("appendSwitch('disable-renderer-backgrounding')")
    expect(start).toBeGreaterThan(-1)
    expect(start).toBeLessThan(firstSwitch)
  })
})
