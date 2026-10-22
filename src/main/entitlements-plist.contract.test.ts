/**
 * Apple Events entitlement (Q10, D6-10, HIG P2/H6). Métis drives Notes and System Events through /usr/bin/osascript
 * (desktop-adapters.ts) and ships NSAppleEventsUsageDescription, so the hardened-runtime Developer ID build must
 * carry the same automation entitlement the Mac App Store build already has.
 *
 * Signed verification (that macOS shows the Automation prompt and the Notes command works on a hardened build) is
 * BLOCKED_EXTERNAL: it needs the owner's signing run. This test pins the declaration, not the prompt.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const APPLE_EVENTS = 'com.apple.security.automation.apple-events'

/** True when the plist sets `key` to `<true/>`; comments between the key and its value are ignored. */
function entitled(file: string, key: string): boolean {
  const xml = readFileSync(join(__dirname, '../../build', file), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
  return new RegExp(`<key>${key.replace(/\./g, '\\.')}</key>\\s*<true\\s*/>`).test(xml)
}

describe('the Apple Events entitlement', () => {
  it.each(['entitlements.mac.plist', 'entitlements.mas.plist'])('is granted in %s', (file) => {
    expect(entitled(file, APPLE_EVENTS)).toBe(true)
  })

  it('stays paired with the usage description electron-builder writes into Info.plist', () => {
    const builder = readFileSync(join(__dirname, '../../electron-builder.yml'), 'utf8')
    expect(builder).toContain('NSAppleEventsUsageDescription')
  })
})
