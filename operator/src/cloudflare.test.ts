import { describe, expect, it } from 'vitest'
import { CF_TOKEN_MISSING, CF_TOKEN_REJECTED } from './cloudflare'
import { handleRequest, type Env } from './index'
import { memoryStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_VAULT_KEY } from './test-fixtures'

const NOW = 1_725_000_000_000
const tony = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }

function env(): Env {
  return {
    OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
    OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
    OPERATOR_SKILL_PRIVATE_KEY: 'unused',
    OPERATOR_VAULT_KEY: TEST_VAULT_KEY
  }
}

describe('Cloudflare Overview fail-loud', () => {
  it('shows the missing-token error when no Cloudflare connection exists', async () => {
    const store = memoryStore()
    const html = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: tony },
      { store, now: NOW }
    ).then((r) => r.text())
    expect(html).toContain('data-cf-overview')
    expect(html).toContain(CF_TOKEN_MISSING)
    expect(html).toContain('data-cf-error')
    expect(html).not.toContain('Seats keep their own keys')
    const dash = (await (
      await handleRequest(
        new Request('https://operator.test/v1/admin/dashboard'),
        env(),
        { access: tony },
        { store, now: NOW }
      )
    ).json()) as { cloudflare: { error: string | null; requests: number | null; token?: string } }
    expect(dash.cloudflare.error).toBe(CF_TOKEN_MISSING)
    expect(dash.cloudflare.requests).toBeNull()
    expect(dash.cloudflare).not.toHaveProperty('token')
    expect(JSON.stringify(dash)).not.toMatch(/\"token\"|cf-token|Bearer /)
  })

  it('pulls token-free Worker/D1/analytics after Tony connects Cloudflare', async () => {
    const store = memoryStore()
    const token = 'cf-acct-token-not-real-zzzz'
    const added = await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'cloudflare-account',
          accountId: '294885a27b3cc0a1cbe5d0ccbe38de4f',
          token
        })
      }),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    expect(((await added.json()) as { last4: string }).last4).toBe('zzzz')

    const cfFetch = async (input: string) => {
      if (input.includes('/workers/scripts') && !input.includes('graphql')) {
        return { status: 200, json: async () => ({ result: [{ id: 'metis-operator' }, { id: 'metis-cloudflare-proxy' }] }) }
      }
      if (input.includes('/d1/database')) {
        return {
          status: 200,
          json: async () => ({
            result: [{ name: 'metis-operator', uuid: '8eb5a081-594c-407c-9470-6a5aa28b9f7c' }]
          })
        }
      }
      if (input.includes('graphql')) {
        return {
          status: 200,
          json: async () => ({
            data: {
              viewer: {
                accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: 42, errors: 1, cpuTimeMs: 18 } }] }]
              }
            }
          })
        }
      }
      return { status: 404, json: async () => ({}) }
    }

    const html = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: tony },
      { store, now: NOW, cfFetch: cfFetch as typeof fetch }
    ).then((r) => r.text())
    expect(html).toContain('metis-operator')
    expect(html).toContain('42')
    expect(html).not.toContain(CF_TOKEN_MISSING)
    expect(html).not.toContain(token)
    const dash = (await (
      await handleRequest(
        new Request('https://operator.test/v1/admin/dashboard'),
        env(),
        { access: tony },
        { store, now: NOW, cfFetch: cfFetch as typeof fetch }
      )
    ).json()) as { cloudflare: { requests: number; errors: number; cpuMs: number; error: string | null } }
    expect(dash.cloudflare).toMatchObject({ requests: 42, errors: 1, cpuMs: 18, error: null })
    expect(JSON.stringify(dash)).not.toContain(token)
  })

  it('fails loud on a rejected Cloudflare token', async () => {
    const store = memoryStore()
    await handleRequest(
      new Request('https://operator.test/v1/admin/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'cloudflare-account',
          accountId: '294885a27b3cc0a1cbe5d0ccbe38de4f',
          token: 'dead-token-aaaa'
        })
      }),
      env(),
      { access: tony },
      { store, now: NOW }
    )
    const cfFetch = async () => ({ status: 403, json: async () => ({ success: false }) })
    const html = await handleRequest(
      new Request('https://operator.test/'),
      env(),
      { access: tony },
      { store, now: NOW, cfFetch: cfFetch as typeof fetch }
    ).then((r) => r.text())
    expect(html).toContain(CF_TOKEN_REJECTED)
    expect(html).not.toContain('dead-token')
  })
})
