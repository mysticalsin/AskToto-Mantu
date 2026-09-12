import { describe, expect, it, vi } from 'vitest'
import { OPERATOR_LICENSE_HEADER } from '@shared/operator-hmac'
import { hashOperatorId, operatorHmacHeaders } from '../../src/main/operator-hmac-sign'
import { handleRequest, type Env } from './index'
import { memoryStore } from './store'
import { TEST_INGEST_SECRET, TEST_PROMPT_KEY, TEST_VAULT_KEY } from './test-fixtures'

describe('MQA-293 desktop licence handshake with the Operator Worker', () => {
  it.each(['text', 'screenshot'] as const)('mints, activates and streams a %s Ask using the desktop signer without a fleet secret on the device', async (kind) => {
    const now = 1_725_000_000_000
    const store = memoryStore()
    const env: Env = {
      OPERATOR_INGEST_SECRET: TEST_INGEST_SECRET,
      OPERATOR_PROMPT_KEY: TEST_PROMPT_KEY,
      OPERATOR_SKILL_PRIVATE_KEY: '',
      OPERATOR_VAULT_KEY: TEST_VAULT_KEY
    }
    const access = { getIdentity: async () => ({ email: 'tony.walteur@gmail.com' }) }
    const adminPost = (path: string, body: Record<string, unknown>) => handleRequest(
      new Request(`https://operator.test${path}`, { method: 'POST', body: JSON.stringify(body) }),
      env, { access }, { store, now }
    )
    const issued = await adminPost('/v1/admin/licenses/generate', { days: 7 })
    expect(issued.status).toBe(200)
    const { license, jti } = await issued.json() as { license: string; jti: string }
    const provisioned = await adminPost('/v1/admin/keys', { provider: 'openai', secret: 'synthetic-upstream-key' })
    expect(provisioned.status).toBe(200)
    expect((await store.listVaultRows())[0].cipher).not.toBe('synthetic-upstream-key')

    // This is the actual Electron-side signer; it receives only the per-user licence.
    const deviceId = hashOperatorId('synthetic-windows-device')
    const devicePost = (path: string, body: Record<string, unknown>) => {
      const text = JSON.stringify(body)
      const headers = operatorHmacHeaders(license, deviceId, text, now)
      expect(headers[OPERATOR_LICENSE_HEADER]).toBe(license)
      expect(JSON.stringify(headers)).not.toContain(TEST_INGEST_SECRET)
      return new Request(`https://operator.test${path}`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: text
      })
    }
    const activated = await handleRequest(devicePost('/v1/heartbeat', {
      os: 'win32', appVersion: '1.8.9', license: 'unlicensed'
    }), env, {}, { store, now })
    expect(activated.status).toBe(200)
    expect(await activated.json()).toMatchObject({ approved: true, tier: 'metis', fundedProviders: ['openai'] })
    expect(await store.getIssuedLicense(jti)).toMatchObject({ activated_device: deviceId })

    const providerFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response([
      'data: {"choices":[{"delta":{"content":"Next step: send the agreed project plan."}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"usage":{"prompt_tokens":9,"completion_tokens":8}}\n\n',
      'data: [DONE]\n\n'
    ].join(''), { headers: { 'content-type': 'text/event-stream' } }))
    const screenshot = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const response = await handleRequest(devicePost('/v1/ask', {
      provider: 'openai', model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'What is the next step?' }],
      ...(kind === 'screenshot' ? { mode: 'vision', image: { mimeType: 'image/png', data: screenshot } } : {})
    }), env, {}, { store, now, providerFetch: providerFetch as typeof fetch })
    expect(response.status).toBe(200)
    const frames = (await response.text()).split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5)) as Record<string, unknown>)
    expect(frames).toContainEqual({ t: 'delta', text: 'Next step: send the agreed project plan.' })
    expect(frames).toContainEqual(expect.objectContaining({ t: 'done', status: 'complete', inputTokens: 9, outputTokens: 8 }))
    expect(JSON.stringify(frames)).not.toContain(license)
    expect(JSON.stringify(frames)).not.toContain('synthetic-upstream-key')
    const upstreamHeaders = new Headers(providerFetch.mock.calls[0]?.[1]?.headers)
    expect(upstreamHeaders.get('authorization')).toBe('Bearer synthetic-upstream-key')
    expect(upstreamHeaders.has(OPERATOR_LICENSE_HEADER)).toBe(false)
    const upstreamBody = JSON.parse(String(providerFetch.mock.calls[0]?.[1]?.body))
    if (kind === 'screenshot') {
      expect(upstreamBody.messages.at(-1).content).toContainEqual({
        type: 'image_url', image_url: { url: `data:image/png;base64,${screenshot}` }
      })
    } else expect(JSON.stringify(upstreamBody)).not.toContain('image_url')
    const asks = await store.listAsks(10)
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ device_id: deviceId, input_tokens: 9, output_tokens: 8 })
    expect(JSON.stringify([asks, await store.listEvents(10), await store.listAudit(10)])).not.toContain(screenshot)
  })
})
