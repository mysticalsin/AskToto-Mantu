import { describe, expect, it, vi } from 'vitest'
import type { SpeechBrokerClient } from '../cloud-stt/broker-client'
import { bindCreateToCapability } from './cloud-speech-ipc-support'

describe('cloud speech IPC capability binding', () => {
  it('preserves the owner signal and absolute operation deadline on create', async () => {
    const response = {
      ok: true as const,
      value: {
        sessionId: '93d23d44-347e-490c-841b-0ff31facbc7e',
        routeId: 'deepgram-via-gateway' as const,
        model: 'nova-3' as const,
        language: 'en',
        configVersion: 'config-r1',
        policyVersion: 'policy-r1'
      }
    }
    const client = {
      createSession: vi.fn(async () => response),
      cancel: vi.fn(async () => ({ ok: true as const }))
    } as unknown as SpeechBrokerClient
    const signal = new AbortController().signal
    const operation = { signal, deadlineAt: 1_500 }
    const wrapped = bindCreateToCapability(
      client,
      {
        routeId: 'deepgram-via-gateway',
        modelId: 'nova-3',
        language: 'en',
        configVersion: 'config-r1',
        policyVersion: 'policy-r1'
      },
      vi.fn()
    )
    const request = { operation: 'create-session' }

    await expect(wrapped.createSession(request, operation)).resolves.toEqual(response)
    expect(client.createSession).toHaveBeenCalledWith(request, operation)
  })
})
