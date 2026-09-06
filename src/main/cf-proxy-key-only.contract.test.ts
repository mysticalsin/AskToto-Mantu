import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Ultron CRITICAL#1 / Tony: release.yml ships Worker proxy key only.
 * Inventory must not see METIS_CLOUDFLARE_API_TOKEN + ACCOUNT_ID embed on the release path.
 */
describe('cf-proxy-key-only (CRITICAL#1)', () => {
  const yml = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8')

  it('release.yml does not embed METIS_CLOUDFLARE_ACCOUNT_ID', () => {
    expect(yml).not.toMatch(/METIS_CLOUDFLARE_ACCOUNT_ID/)
  })

  it('release.yml does not embed METIS_CLOUDFLARE_API_TOKEN (use METIS_PROXY_KEY)', () => {
    expect(yml).not.toMatch(/METIS_CLOUDFLARE_API_TOKEN/)
  })

  it('release.yml embeds via METIS_PROXY_KEY only', () => {
    expect(yml).toMatch(/METIS_PROXY_KEY:\s*\$\{\{\s*secrets\.METIS_PROXY_KEY\s*\}\}/)
  })
})
