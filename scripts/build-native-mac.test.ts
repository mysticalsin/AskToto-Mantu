import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { syncNativeMarketingVersion, xcodebuildSigningArgs } from './build-native-mac.mjs'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('syncNativeMarketingVersion', () => {
  it('rewrites MARKETING_VERSION to match package.json version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metis-native-ver-'))
    scratch.push(dir)
    const yml = join(dir, 'project.yml')
    writeFileSync(
      yml,
      'name: Metis\ntargets:\n  Metis:\n    settings:\n      base:\n        MARKETING_VERSION: "0.1.0"\n        CURRENT_PROJECT_VERSION: "1"\n'
    )
    expect(syncNativeMarketingVersion('1.7.0', yml)).toBe('1.7.0')
    expect(readFileSync(yml, 'utf8')).toContain('MARKETING_VERSION: "1.7.0"')
    expect(readFileSync(yml, 'utf8')).not.toContain('0.1.0')
  })
})

describe('xcodebuildSigningArgs', () => {
  it('uses ad-hoc signing when no QA identity is provided', () => {
    expect(xcodebuildSigningArgs()).toEqual(['CODE_SIGN_IDENTITY=-', 'CODE_SIGNING_ALLOWED=YES', 'CODE_SIGNING_REQUIRED=NO'])
    expect(xcodebuildSigningArgs('-')).toEqual(['CODE_SIGN_IDENTITY=-', 'CODE_SIGNING_ALLOWED=YES', 'CODE_SIGNING_REQUIRED=NO'])
  })

  it('uses the QA identity without allowing Developer ID signing', () => {
    expect(xcodebuildSigningArgs('A'.repeat(40))).toEqual([
      `CODE_SIGN_IDENTITY=${'A'.repeat(40)}`,
      'CODE_SIGNING_ALLOWED=YES',
      'CODE_SIGNING_REQUIRED=YES'
    ])
    expect(() => xcodebuildSigningArgs('Developer ID Application: Example')).toThrow(/Developer ID/)
  })
})
