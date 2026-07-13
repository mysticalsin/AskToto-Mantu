import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  description: string
  scripts: Record<string, string>
}

describe('installer branding', () => {
  it('uses a customer-facing Métis file description without internal migration notes', () => {
    expect(pkg.description).toBe('Métis - AI desktop overlay assistant')
  })
})

describe('direct release signing gates', () => {
  it('requires an explicit expected Windows signer identity', () => {
    const result = spawnSync(process.execPath, [join(__dirname, 'check-release-secrets.mjs'), 'win'], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH || '',
        GH_TOKEN: 'test-token',
        WIN_CSC_LINK: 'test-certificate',
        WIN_CSC_KEY_PASSWORD: 'test-password'
      }
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('WIN_CSC_EXPECTED_SUBJECT')
  })

  it('verifies produced signatures in both direct release commands', () => {
    expect(pkg.scripts['release:build:mac']).toContain('node scripts/verify-signing.mjs --require-notarized')
    expect(pkg.scripts['release:build:win']).toContain('node scripts/verify-signing.mjs')
  })
})
