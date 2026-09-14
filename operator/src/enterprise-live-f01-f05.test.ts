import { describe, expect, it } from 'vitest'
import {
  PORTAL_CF_DEEPSEEK_FLASH,
  PORTAL_CF_DEEPSEEK_PRO,
  resolvePortalCloudflareModel
} from '../../src/shared/ask-routing'
import { parseUseBody, screenshotGatewayHeaders } from './use'
import { fixtureDashboard } from './render/fixture'
import { renderRealtime } from './render/pages/realtime'

describe('enterprise-live F01 portal tier', () => {
  it('keeps Flash for base/legacy', () => {
    expect(resolvePortalCloudflareModel(PORTAL_CF_DEEPSEEK_PRO, 'base')).toBe(PORTAL_CF_DEEPSEEK_FLASH)
    expect(resolvePortalCloudflareModel('anything', 'base')).toBe(PORTAL_CF_DEEPSEEK_FLASH)
  })

  it('preserves Pro when tier is deep', () => {
    expect(resolvePortalCloudflareModel(PORTAL_CF_DEEPSEEK_PRO, 'deep')).toBe(PORTAL_CF_DEEPSEEK_PRO)
  })

  it('parseUseBody accepts tier=deep', () => {
    const parsed = parseUseBody(
      JSON.stringify({
        provider: 'cloudflare',
        model: PORTAL_CF_DEEPSEEK_PRO,
        tier: 'deep',
        system: 'sys',
        messages: [{ role: 'user', content: 'hi' }]
      })
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.req.tier).toBe('deep')
    expect(parsed.req.model).toBe(PORTAL_CF_DEEPSEEK_PRO)
  })
})

describe('enterprise-live F05 gateway privacy', () => {
  it('suppresses payload logs for text asks, not only screenshots', () => {
    const textReq = {
      provider: 'cloudflare',
      model: PORTAL_CF_DEEPSEEK_FLASH,
      system: 's',
      messages: [{ role: 'user' as const, content: 'meeting notes' }],
      temperature: 0,
      maxTokens: 100
    }
    expect(screenshotGatewayHeaders(textReq)).toEqual({
      'cf-aig-collect-log-payload': 'false',
      'cf-aig-skip-cache': 'true'
    })
  })
})

describe('realtime every real seat', () => {
  it('lists every profile even when some are live', async () => {
    const data = await fixtureDashboard()
    const base = data.profiles[0]
    data.profiles = Array.from({ length: 20 }, (_, i) => ({
      ...base,
      device: `dev${i}`,
      deviceId: `device-${i}`,
      hostname: `host-${i}.local`,
      live: i < 3
    }))
    const html = renderRealtime(data, { now: data.now, theme: 'dark' })
    for (let i = 0; i < 20; i++) {
      expect(html).toContain(`host-${i}.local`)
    }
    expect(html).toContain('People · 20 seats · 3 live')
    expect(html).toContain('refreshed every 5 seconds')
    expect(html).toContain('rt-map-svg')
  })
})
