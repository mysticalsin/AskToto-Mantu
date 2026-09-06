import { describe, expect, it } from 'vitest'
import { fundedProvidersFromEnv, operatorHostedKey } from './funded'

describe('Operator fundedProviders from env', () => {
  it('lists IDs for present env keys and never returns the secret', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-secret', OPENAI_API_KEY: 'sk-openai-secret' }
    expect(fundedProvidersFromEnv(env)).toEqual(['anthropic', 'openai'])
    const blob = JSON.stringify(fundedProvidersFromEnv(env))
    expect(blob).not.toContain('sk-ant-secret')
    expect(blob).not.toContain('sk-openai-secret')
  })

  it('never funds CLI, Dust, local, or a Cloudflare account even if env looks set', () => {
    const env = {
      DUST_API_KEY: 'dust-secret',
      METIS_PROXY_KEY: 'cf-secret',
      ANTHROPIC_API_KEY: 'sk-ant-ok'
    }
    expect(fundedProvidersFromEnv(env)).toEqual(['anthropic'])
    expect(operatorHostedKey(env, 'claude-cli')).toBe('')
    expect(operatorHostedKey(env, 'dust')).toBe('')
    expect(operatorHostedKey(env, 'cloudflare')).toBe('')
  })

  it('omits blank secrets', () => {
    expect(fundedProvidersFromEnv({ ANTHROPIC_API_KEY: '   ', OPENAI_API_KEY: '' })).toEqual([])
  })
})
