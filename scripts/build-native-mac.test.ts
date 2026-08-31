import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { syncNativeMarketingVersion } from './build-native-mac.mjs'

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
