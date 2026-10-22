import { describe, expect, it, vi } from 'vitest'
import { createListeningStateHandler } from './listening-state-ipc'

function harness(
  releaseParakeet: () => Promise<void>,
  releaseSpeakerEmbedding: () => Promise<unknown> = async () => undefined
) {
  const deps = {
    assertMainWindow: vi.fn(),
    requireAuth: vi.fn(() => true),
    acceptTransition: vi.fn((_change: { on: boolean; startedAt?: number }, authorizeStart: () => boolean) =>
      _change.on ? authorizeStart() : true
    ),
    consumeMeetingStartActivation: vi.fn(() => true),
    setListeningActive: vi.fn(),
    setTrayRecording: vi.fn(),
    setRecordingPowerSaveBlock: vi.fn(),
    onMeetingStart: vi.fn(),
    startAudit: vi.fn(),
    releaseParakeet: vi.fn(releaseParakeet),
    releaseSpeakerEmbedding: vi.fn(releaseSpeakerEmbedding)
  }
  return { handler: createListeningStateHandler(deps), deps }
}

describe('registered listening-state native lifecycle', () => {
  it('passes validated structured state to the authoritative acceptor before any side effect', async () => {
    const { handler, deps } = harness(async () => undefined)
    deps.acceptTransition.mockImplementation((change) => {
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
    expect(deps.consumeMeetingStartActivation).not.toHaveBeenCalled()
  })

  it('does nothing when the owner rejects a stale stop or duplicate start', async () => {
    const { handler, deps } = harness(async () => undefined)
    deps.acceptTransition.mockReturnValue(false)
    await handler({}, { on: false, startedAt: 100 })
    await handler({}, { on: true, startedAt: 200 })
    expect(deps.acceptTransition.mock.calls).toEqual([
      [{ on: false, startedAt: 100 }, expect.any(Function)],
      [{ on: true, startedAt: 200 }, expect.any(Function)]
    ])
    for (const key of [
      'setListeningActive',
      'setTrayRecording',
      'setRecordingPowerSaveBlock',
      'onMeetingStart',
      'releaseParakeet',
      'releaseSpeakerEmbedding'
    ] as const) {
      expect(deps[key]).not.toHaveBeenCalled()
    }
  })

  it.each([
    null,
    [],
    1,
    'false',
    {},
    { on: 1 },
    { on: false, startedAt: '123' },
    { on: true, startedAt: NaN },
    { on: false, startedAt: 0 }
  ])('ignores malformed state %j before ownership or side effects', async (payload) => {
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
    expect(deps.acceptTransition.mock.calls).toEqual([
      [{ on: true }, expect.any(Function)],
      [{ on: false }, expect.any(Function)]
    ])
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
    const exit = new Promise<void>((resolve) => {
      confirmExit = resolve
    })
    let confirmSpeakerExit!: () => void
    const speakerExit = new Promise<void>((resolve) => {
      confirmSpeakerExit = resolve
    })
    const { handler, deps } = harness(
      () => exit,
      () => speakerExit
    )

    let settled = false
    const stopping = handler({ sender: 'main-window' }, false).then(() => {
      settled = true
    })
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

  it('consumes a main-owned start grant inside the accepted on-transition before side effects', async () => {
    const { handler, deps } = harness(async () => undefined)
    deps.consumeMeetingStartActivation.mockReturnValue(false)
    const rejected = await handler({ sender: 'main-window' }, { on: true, startedAt: 300 })
    expect(rejected).toBe(false)
    expect(deps.consumeMeetingStartActivation).toHaveBeenCalledTimes(1)
    expect(deps.setListeningActive).not.toHaveBeenCalled()

    deps.consumeMeetingStartActivation.mockReturnValue(true)
    const accepted = await handler({ sender: 'main-window' }, { on: true, startedAt: 301 })
    expect(accepted).toBe(true)
    expect(deps.consumeMeetingStartActivation).toHaveBeenCalledTimes(2)
    expect(deps.setListeningActive).toHaveBeenCalledExactlyOnceWith(true)
  })
})

describe('listening-state Start audit (Q14)', () => {
  it('records an accepted start, once, and no stop', async () => {
    const { handler, deps } = harness(async () => undefined)
    await handler({}, { on: true, startedAt: 5 })
    await handler({}, { on: false, startedAt: 5 })
    expect(deps.startAudit.mock.calls).toEqual([['transition', 'accepted']])
  })

  it('says the activation grant was missing when the owner asked for one and got none', async () => {
    const { handler, deps } = harness(async () => undefined)
    deps.consumeMeetingStartActivation.mockReturnValue(false)
    expect(await handler({}, { on: true, startedAt: 5 })).toBe(false)
    expect(deps.startAudit).toHaveBeenCalledExactlyOnceWith('transition', 'denied', 'no-activation-grant')
  })

  it('separates a rejection before the grant was even asked for from one after it was consumed', async () => {
    const before = harness(async () => undefined)
    before.deps.acceptTransition.mockReturnValue(false)
    await before.handler({}, { on: true, startedAt: 5 })
    expect(before.deps.startAudit).toHaveBeenCalledExactlyOnceWith('transition', 'denied', 'rejected-before-grant')

    const after = harness(async () => undefined)
    after.deps.acceptTransition.mockImplementation((_change, authorizeStart) => {
      authorizeStart()
      return false
    })
    await after.handler({}, { on: true, startedAt: 5 })
    expect(after.deps.startAudit).toHaveBeenCalledExactlyOnceWith('transition', 'denied', 'rejected-after-grant')
  })

  it('records a signed-out start and a malformed start request, and nothing for a refused stop', async () => {
    const signedOut = harness(async () => undefined)
    signedOut.deps.requireAuth.mockReturnValue(false)
    await signedOut.handler({}, { on: true, startedAt: 5 })
    expect(signedOut.deps.startAudit).toHaveBeenCalledExactlyOnceWith('transition', 'denied', 'not-authenticated')

    const malformed = harness(async () => undefined)
    await malformed.handler({}, { on: true, startedAt: 'x' })
    expect(malformed.deps.startAudit).toHaveBeenCalledExactlyOnceWith('transition', 'denied', 'invalid-request')

    const stop = harness(async () => undefined)
    stop.deps.acceptTransition.mockReturnValue(false)
    await stop.handler({}, { on: false, startedAt: 5 })
    expect(stop.deps.startAudit).not.toHaveBeenCalled()
  })
})
