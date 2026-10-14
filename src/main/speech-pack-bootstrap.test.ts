import { afterEach, describe, expect, it, vi } from 'vitest'
import { startSpeechPackDesktop } from './speech-pack-bootstrap'

const mocks = vi.hoisted(() => {
  const service = { policyChanged: vi.fn(), selectionChanged: vi.fn(), captureActivityChanged: vi.fn(), shutdown: vi.fn() }
  const unregister = vi.fn()
  return { service, unregister, createSpeechPackService: vi.fn(() => service), registerSpeechPackIpc: vi.fn(() => unregister) }
})
vi.mock('./features/components', () => mocks)

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

const options = () => ({
  resourcesRoot: '/resources', packaged: true, rootDir: '/packs', fixtureWavPath: '/fixture.wav',
  selectedEngine: () => 'whisper' as const, policyAllowsTransfer: () => true,
  captureActive: () => false,
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }, assertMainWindow: vi.fn(), sendProgress: vi.fn()
})

describe('speech-pack desktop lifecycle', () => {
  it('refreshes current policy, selection and capture without starting a transfer', async () => {
    vi.useFakeTimers()
    const active = vi.fn().mockReturnValue(false)
    const desktop = startSpeechPackDesktop({ ...options(), captureActive: active })
    expect(mocks.service.captureActivityChanged).toHaveBeenLastCalledWith(false)
    active.mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.service.policyChanged).toHaveBeenCalledTimes(2)
    expect(mocks.service.selectionChanged).toHaveBeenCalledTimes(2)
    expect(mocks.service.captureActivityChanged).toHaveBeenLastCalledWith(true)
    await desktop.shutdown()
    await vi.advanceTimersByTimeAsync(2000)
    expect(mocks.service.policyChanged).toHaveBeenCalledTimes(2)
    expect(mocks.unregister).toHaveBeenCalledOnce()
  })

  it('keeps transfers disallowed when the policy reader throws', async () => {
    const desktop = startSpeechPackDesktop({ ...options(), policyAllowsTransfer: () => { throw new Error('private failure') } })
    const passed = mocks.createSpeechPackService.mock.calls.at(-1)?.[0] as unknown as { policyAllowsTransfer: () => boolean }
    expect(passed.policyAllowsTransfer()).toBe(false)
    await desktop.shutdown()
  })

  it('shares one shutdown promise and waits for the owned service', async () => {
    let finish: () => void = () => {}
    mocks.service.shutdown.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const desktop = startSpeechPackDesktop(options())
    const first = desktop.shutdown()
    const second = desktop.shutdown()
    expect(first).toBe(second)
    expect(mocks.unregister).toHaveBeenCalledOnce()
    let completed = false
    void first.then(() => { completed = true })
    await Promise.resolve()
    expect(completed).toBe(false)
    finish()
    await first
    expect(mocks.service.shutdown).toHaveBeenCalledOnce()
  })
})
