import { describe, expect, it } from 'vitest'
import { CF_CALLBACK_PATH, CF_CONNECT_PATH, CF_DASH_LOGIN } from './cloudflare-connect'
import { handleRequest, type Env } from './index'
import { memoryStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_TEAM_DOMAIN } from './test-fixtures'

const NOW = 1_725_000_000_000
const tony = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }

function env(): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused',
    TEAM_DOMAIN: TEST_TEAM_DOMAIN
  }
}

describe('Cloudflare connect is a login redirect (#108)', () => {
  it('identity GET /cloudflare/connect 302s to Cloudflare login, not a paste form', async () => {
    const res = await handleRequest(
      new Request(`https://operator.test${CF_CONNECT_PATH}`),
      env(),
      { access: tony },
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(302)
    const loc = res.headers.get('location') || ''
    expect(loc.startsWith(CF_DASH_LOGIN)).toBe(true)
    expect(loc).toContain(encodeURIComponent('https://operator.test/cloudflare/callback'))
    expect(await res.text()).not.toContain('Account ID')
  })

  it('identity GET /cloudflare/callback returns to Keys', async () => {
    const res = await handleRequest(
      new Request(`https://operator.test${CF_CALLBACK_PATH}`),
      env(),
      { access: tony },
      { store: memoryStore(), now: NOW }
    )
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/#keys')
  })

  it('Keys HTML has rotate/revoke columns and no Account ID + token paste', async () => {
    const html = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: tony },
      { store: memoryStore(), now: NOW }
    ).then((r) => r.text())
    expect(html).toContain('id="cf-connect"')
    expect(html).toContain('href="/cloudflare/connect"')
    expect(html).toContain('<th>Rotate</th>')
    expect(html).toContain('<th>Revoke</th>')
    expect(html).not.toContain('name="accountId"')
    expect(html).not.toContain('placeholder="API token"')
    expect(html).not.toContain('id="cf-add"')
    expect(html).not.toContain('Connect Account ID and API token')
  })
})
