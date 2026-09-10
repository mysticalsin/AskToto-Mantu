import { describe, expect, it, vi } from 'vitest'
import { createListeningStateHandler } from './listening-state-ipc'

function harness(
  releaseParakeet: () => Promise<void>,
  releaseSpeakerEmbedding: () => Promise<unknown> = async () => undefined
) {
  const deps = {
    assertMainWindow: vi.fn(),
    requireAuth: vi.fn(() => true),
    acceptTransition: vi.fn((_change: { on: boolean; startedAt?: number }) => true),
    setListeningActive: vi.fn(),
    setTrayRecording: vi.fn(),
    setRecordingPowerSaveBlock: vi.fn(),
    onMeetingStart: vi.fn(),
    releaseParakeet: vi.fn(releaseParakeet),
    releaseSpeakerEmbedding: vi.fn(releaseSpeakerEmbedding)
  }
  return { handler: createListeningStateHandler(deps), deps }
}

describe('registered listening-state native lifecycle', () => {
  it('passes validated structured state to the authoritative acceptor before any side effect', async () => {
    const { handler, deps } = harness(async () => undefined)
    deps.acceptTransition.mockImplementation(change => {
      expect(change).toEqual({ on: false, startedAt: 123 })
      expect(deps.setListeningActive).not.toHaveBeenCalled()
      expect(deps.releaseParakeet).not.toHaveBeenCalled()
      return true
    })
    await handler({}, { on: false, startedAt: 123 })
    expect(deps.acceptTransition).toHaveBeenCalledTimes(1)
    expect(deps.setListeningActive).toHaveBeenCalledExactlyOnceWith(false)
    expect(deps.releaseParakeet).toHaveBeenCalledTimes(1)
    expect(deps.onMeetingStart).not.toHaveBeenCalled()
  })

  it('does nothing when the owner rejects a stale stop or duplicate start', async () => {
    const { handler, deps } = harness(async () => undefined)
    deps.acceptTransition.mockReturnValue(false)
    await handler({}, { on: false, startedAt: 100 })
    await handler({}, { on: true, startedAt: 200 })
    expect(deps.acceptTransition.mock.calls).toEqual([
      [{ on: false, startedAt: 100 }], [{ on: true, startedAt: 200 }]
    ])
    for (const key of ['setListeningActive', 'setTrayRecording', 'setRecordingPowerSaveBlock',
      'onMeetingStart', 'releaseParakeet', 'releaseSpeakerEmbedding'] as const) {
      expect(deps[key]).not.toHaveBeenCalled()
    }
  })

  it.each([null, [], 1, 'false', {}, { on: 1 }, { on: false, startedAt: '123' },
    { on: true, startedAt: NaN }, { on: false, startedAt: 0 }])('ignores malformed state %j before ownership or side effects', async payload => {
    const { handler, deps } = harness(async () => undefined)
    await handler({}, payload)
    expect(deps.acceptTransition).not.toHaveBeenCalled()
    expect(deps.setListeningActive).not.toHaveBeenCalled()
    expect(deps.releaseParakeet).not.toHaveBeenCalled()
    expect(deps.releaseSpeakerEmbedding).not.toHaveBeenCalled()
  })

  it('normalizes legacy booleans but still consults the owner before a legacy stop', async () => {
    const { handler, deps } = harness(async () => undefined)
    await handler({}, true)
    deps.acceptTransition.mockReturnValue(false)
    await handler({}, false)
    expect(deps.acceptTransition.mock.calls).toEqual([[{ on: true }], [{ on: false }]])
    expect(deps.setListeningActive).toHaveBeenCalledExactlyOnceWith(true)
    expect(deps.releaseParakeet).not.toHaveBeenCalled()
  })

  it('does not consult identity or mutate state without authentication', async () => {
    const { handler, deps } = harness(async () => undefined)
    deps.requireAuth.mockReturnValue(false)
    await handler({}, { on: true, startedAt: 123 })
    expect(deps.acceptTransition).not.toHaveBeenCalled()
    expect(deps.setListeningActive).not.toHaveBeenCalled()
  })

  it('keeps the stop IPC pending until both exact helper exits settle release', async () => {
    let confirmExit!: () => void
    const exit = new Promise<void>((resolve) => { confirmExit = resolve })
    let confirmSpeakerExit!: () => void
    const speakerExit = new Promise<void>((resolve) => { confirmSpeakerExit = resolve })
    const { handler, deps } = harness(() => exit, () => speakerExit)

    let settled = false
    const stopping = handler({ sender: 'main-window' }, false).then(() => { settled = true })
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(deps.setListeningActive).toHaveBeenCalledWith(false)
    expect(deps.releaseParakeet).toHaveBeenCalledTimes(1)
    expect(deps.releaseSpeakerEmbedding).toHaveBeenCalledTimes(1)
    confirmExit()
    await Promise.resolve()
    expect(settled).toBe(false)
    confirmSpeakerExit()
    await stopping
    expect(settled).toBe(true)
  })

  it('propagates an unconfirmed-exit rejection through the registered stop IPC', async () => {
    const releaseSpeakerEmbedding = vi.fn(async () => undefined)
    const { handler } = harness(async () => {
      throw new Error('Could not confirm that the Parakeet helper exited.')
    }, releaseSpeakerEmbedding)

    await expect(handler({}, false)).rejects.toThrow(/could not confirm/i)
    expect(releaseSpeakerEmbedding).toHaveBeenCalledTimes(1)
  })

  it('preserves meeting-start side effects without releasing Parakeet', async () => {
    const { handler, deps } = harness(async () => undefined)

    await handler({}, true)

    expect(deps.setListeningActive).toHaveBeenCalledWith(true)
    expect(deps.setTrayRecording).toHaveBeenCalledWith(true)
    expect(deps.setRecordingPowerSaveBlock).toHaveBeenCalledWith(true)
    expect(deps.onMeetingStart).toHaveBeenCalledTimes(1)
    expect(deps.releaseParakeet).not.toHaveBeenCalled()
    expect(deps.releaseSpeakerEmbedding).not.toHaveBeenCalled()
  })
})
