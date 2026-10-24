import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/ipc'

const pin = vi.hoisted(() => vi.fn((_s: unknown, _cap: string, _provider: string, current: string) => current))
vi.mock('./model-policy-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./model-policy-client')>()),
  resolveManagedModel: pin
}))

import { runTranscriptCompletion, type RunImportedRecapDeps } from './import-recap'

const settings = (): Settings => ({
  ...DEFAULT_SETTINGS,
  provider: 'anthropic',
  providerModels: { ...DEFAULT_SETTINGS.providerModels, anthropic: 'synthetic-user-model' }
})

type Opts = {
  model: string
  idleMs: number
  system: string
  handlers: { onDelta: (d: string) => void; onDone: (u: object) => void; onError: (e: string) => void }
}

const deps = (createStream: unknown): RunImportedRecapDeps => ({
  getSettings: settings,
  getApiKey: () => 'k',
  getAllowedProviders: () => null,
  providerBaseUrl: () => '',
  redactSecrets: (t) => t,
  createStream: createStream as never
})

const request = {
  reqId: 'translation-1',
  system: 'sys',
  transcript: 'bonjour',
  idleMs: 4_000,
  policyCapability: 'recap' as const,
  candidates: ['anthropic' as const],
  label: 'Translation',
  noneMessage: 'none'
}

describe('runTranscriptCompletion (G73)', () => {
  beforeEach(() => pin.mockClear())

  it('runTranscriptCompletion pins the policy model for the given capability', async () => {
    pin.mockImplementation(() => 'synthetic-policy-model')
    const createStream = vi.fn((opts: Opts) => {
      opts.handlers.onDelta(' hello ')
      opts.handlers.onDone({})
      return { abort: () => {} }
    })
    await expect(runTranscriptCompletion(request, deps(createStream))).resolves.toBe('hello')
    expect(pin).toHaveBeenCalledWith(expect.anything(), 'recap', 'anthropic', expect.any(String))
    const opts = createStream.mock.calls[0][0] as Opts
    expect(opts.model).toBe('synthetic-policy-model')
    expect(opts.idleMs).toBe(4_000)
  })

  it('falls back to the next candidate and reports labelled failure copy', async () => {
    const createStream = vi.fn((opts: Opts) => {
      opts.handlers.onError('boom')
      return { abort: () => {} }
    })
    await expect(runTranscriptCompletion(request, deps(createStream))).rejects.toThrow(
      /Translation provider failed before completion/
    )
  })

  it('aborts the stream and stops when the signal fires', async () => {
    const abort = vi.fn()
    const createStream = vi.fn(() => ({ abort }))
    const controller = new AbortController()
    const pending = runTranscriptCompletion({ ...request, signal: controller.signal }, deps(createStream))
    controller.abort()
    await expect(pending).rejects.toThrow(/cancelled/)
    expect(abort).toHaveBeenCalledTimes(1)
    expect(createStream).toHaveBeenCalledTimes(1)
  })
})
