import { describe, expect, it } from 'vitest'
import { fixtureDashboard } from '../fixture'
import { renderModels } from './models'
import { MODEL_POLICY_CAPABILITIES, type ModelPolicyDocument } from '../../../../src/shared/model-policy'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const, nonce: 'test-nonce' }

function policy(): ModelPolicyDocument {
  return {
    version: CTX.now,
    updatedAt: CTX.now,
    updatedBy: 'owner@example.test',
    capabilities: Object.fromEntries(
      MODEL_POLICY_CAPABILITIES.map((k) => [k, { provider: 'anthropic', model: 'claude-sonnet-4-6', fallbacks: [] }])
    ) as ModelPolicyDocument['capabilities']
  }
}

describe('renderModels', () => {
  it('shows "not managed" and no edit form when there is no policy and the viewer is not the owner', async () => {
    const data = await fixtureDashboard()
    data.modelPolicy = { policy: null, isOwner: false, history: [] }
    const html = renderModels(data, CTX)
    expect(html).toContain('>Models<')
    expect(html).toContain('Not managed')
    expect(html).not.toContain('id="model-policy-form"')
    expect(html).toContain('Only the fleet owner can change this policy.')
  })

  it('renders the current policy read-only for a non-owner admin', async () => {
    const data = await fixtureDashboard()
    data.modelPolicy = { policy: policy(), isOwner: false, history: [] }
    const html = renderModels(data, CTX)
    expect(html).toContain('anthropic')
    expect(html).toContain('claude-sonnet-4-6')
    expect(html).not.toContain('id="model-policy-form"')
  })

  it('renders the edit form with current values pre-filled for the owner', async () => {
    const data = await fixtureDashboard()
    data.modelPolicy = { policy: policy(), isOwner: true, history: [] }
    const html = renderModels(data, CTX)
    expect(html).toContain('id="model-policy-form"')
    expect(html).toContain('name="askChat.provider" value="anthropic"')
    expect(html).toContain('name="askChat.model" value="claude-sonnet-4-6"')
    expect(html).toContain(`nonce="${CTX.nonce}"`)
  })

  it('does not render the edit form for the owner when no nonce was minted', async () => {
    const data = await fixtureDashboard()
    data.modelPolicy = { policy: policy(), isOwner: true, history: [] }
    const html = renderModels(data, { now: CTX.now, theme: 'light' })
    expect(html).not.toContain('id="model-policy-form"')
  })

  it('renders audit history rows when present, or the named empty state when not', async () => {
    const data = await fixtureDashboard()
    data.modelPolicy = {
      policy: policy(),
      isOwner: false,
      history: [{ ts: CTX.now, actor: 'owner@example.test', action: 'model-policy.update', detail: 'before {} after {}' }]
    }
    const withHistory = renderModels(data, CTX)
    expect(withHistory).toContain('<table>')
    expect(withHistory).toContain('model-policy.update')

    data.modelPolicy = { policy: null, isOwner: false, history: [] }
    const withoutHistory = renderModels(data, CTX)
    expect(withoutHistory).toContain('No model policy changes yet.')
  })

  it('escapes provider/model values instead of interpolating them raw', async () => {
    const data = await fixtureDashboard()
    const tampered = policy()
    tampered.capabilities.askChat = { provider: '<script>alert(1)</script>', model: 'x', fallbacks: [] }
    data.modelPolicy = { policy: tampered, isOwner: false, history: [] }
    const html = renderModels(data, CTX)
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
