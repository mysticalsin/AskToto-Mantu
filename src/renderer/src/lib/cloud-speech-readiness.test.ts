import { describe, expect, it } from 'vitest'
import { CloudSpeechCapabilitySchema } from '@shared/cloud-speech'
import { cloudSpeechRowStatus } from './cloud-speech-readiness'

const ready = CloudSpeechCapabilitySchema.parse({
  disclosureVersion: 'cloud-speech-v1',
  selected: { engine: 'cloudflare-nova3', routeId: 'workers-ai-nova3', modelId: '@cf/deepgram/nova-3' },
  allowed: [{ engine: 'cloudflare-nova3', routeId: 'workers-ai-nova3', modelId: '@cf/deepgram/nova-3' }],
  ready: true,
  refusal: null
})

describe('cloud speech readiness copy', () => {
  it('shows a ready label only for the real selected route', () => {
    expect(cloudSpeechRowStatus(ready)).toEqual({ state: 'ready', detail: 'Ready: Cloudflare Workers AI · Nova-3' })
    const gateway = CloudSpeechCapabilitySchema.parse({
      ...ready,
      selected: { engine: 'deepgram-nova3', routeId: 'deepgram-via-gateway', modelId: 'nova-3' },
      allowed: [{ engine: 'deepgram-nova3', routeId: 'deepgram-via-gateway', modelId: 'nova-3' }]
    })
    expect(cloudSpeechRowStatus(gateway)).toEqual({
      state: 'ready',
      detail: 'Ready: Deepgram Nova-3 through Cloudflare AI Gateway'
    })
    expect(cloudSpeechRowStatus(ready, 'deepgram-nova3')).toEqual({
      state: 'action',
      detail: 'The saved route does not match the currently approved route.'
    })
    expect(cloudSpeechRowStatus(ready, null)).toEqual({
      state: 'action',
      detail: 'Choose an allowed cloud speech route to enable cloud transcription.'
    })
  })

  it('keeps pending and refusal states honest and uses only fixed refusal copy', () => {
    expect(cloudSpeechRowStatus(null)).toEqual({
      state: 'checking',
      detail: 'Checking the approved cloud speech route…'
    })
    const refused = CloudSpeechCapabilitySchema.parse({
      disclosureVersion: 'cloud-speech-v1',
      selected: null,
      allowed: [],
      ready: false,
      refusal: 'POLICY'
    })
    expect(cloudSpeechRowStatus(refused)).toEqual({
      state: 'action',
      detail: 'No verified speech policy is available.'
    })
    expect(cloudSpeechRowStatus(refused).detail).not.toContain('secret')
  })
})

describe('Q09 D1-10: a failed capability check is actionable, not a permanent spinner', () => {
  it('keeps checking while the first answer is pending', () => {
    expect(cloudSpeechRowStatus(null).state).toBe('checking')
    expect(cloudSpeechRowStatus(null, undefined, false).state).toBe('checking')
  })

  it('turns a rejected check into an action row with a retry reason', () => {
    expect(cloudSpeechRowStatus(null, undefined, true)).toEqual({
      state: 'action',
      detail: "Couldn't check cloud speech. Try again."
    })
  })

  it('never lets a stale failure flag hide a real answer', () => {
    expect(cloudSpeechRowStatus(ready, undefined, true)).toEqual({
      state: 'ready',
      detail: 'Ready: Cloudflare Workers AI · Nova-3'
    })
  })
})
