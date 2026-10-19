import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InputSessionRevoked, MeetingMicCaptureRevoked } from '@shared/ipc'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function mediaStream(track: MediaStreamTrack): MediaStream {
  return { getTracks: () => [track] } as unknown as MediaStream
}

const context = { authSessionGeneration: 8, contextRevision: 13 }
const lease = {
  sessionId: 'a'.repeat(48),
  source: 'deliberate-talk' as const,
  purpose: 'conversation' as const,
  activation: 'explicit' as const,
  authSessionGeneration: context.authSessionGeneration,
  contextRevision: context.contextRevision,
  revision: 3,
  startedAt: 1234,
  actionAuthority: false
}

function setup() {
  const capture = deferred<MediaStream>()
  let inputRevoked: ((event: InputSessionRevoked) => void) | undefined
  let meetingRevoked: ((event: MeetingMicCaptureRevoked) => void) | undefined
  let deviceChange: (() => void) | undefined
  const track = { stop: vi.fn() } as unknown as MediaStreamTrack
  const getUserMedia = vi.fn(() => capture.promise)
  const stopInputSession = vi.fn(async () => ({ ok: true as const }))
  const releaseMeetingMicCapture = vi.fn(async () => true)
  const mediaDevices = {
    getUserMedia,
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'devicechange') deviceChange = listener as () => void
    }),
    removeEventListener: vi.fn()
  }
  vi.stubGlobal('navigator', { mediaDevices })
  vi.stubGlobal('window', {
    toto: {
      getInputSessionContext: vi.fn(async () => context),
      startInputSession: vi.fn(async () => ({ ok: true as const, lease })),
      confirmInputSession: vi.fn(async () => true),
      stopInputSession,
      onInputSessionRevoked: vi.fn((listener: (event: InputSessionRevoked) => void) => {
        inputRevoked = listener
        return vi.fn()
      }),
      meetingMicAdmission: vi.fn(async (startedAt: number) => ({
        captureId: '00000000-0000-4000-8000-000000000001',
        startedAt
      })),
      confirmMeetingMicCapture: vi.fn(async () => true),
      releaseMeetingMicCapture,
      onMeetingMicCaptureRevoked: vi.fn((listener: (event: MeetingMicCaptureRevoked) => void) => {
        meetingRevoked = listener
        return vi.fn()
      })
    }
  })
  return {
    capture,
    track,
    getUserMedia,
    stopInputSession,
    releaseMeetingMicCapture,
    mediaDevices,
    revokeInput(event: InputSessionRevoked) {
      inputRevoked?.(event)
    },
    revokeMeeting(event: MeetingMicCaptureRevoked) {
      meetingRevoked?.(event)
    },
    changeDevice() {
      deviceChange?.()
    }
  }
}

beforeEach(() => {
  vi.resetModules()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('interactive microphone admission lifecycle', () => {
  it('does not start a lease when cancellation arrives while context lookup is pending', async () => {
    const contextResult = deferred<typeof context>()
    const env = setup()
    vi.mocked(window.toto.getInputSessionContext).mockReturnValue(contextResult.promise)
    const controller = new AbortController()
    const { acquireInteractiveMic } = await import('./input-mic-admission')
    const pending = acquireInteractiveMic({ audio: true }, 'conversation', 'deliberate-talk', controller.signal)
    controller.abort()
    contextResult.resolve(context)
    await expect(pending).rejects.toThrow('cancelled')
    expect(window.toto.startInputSession).not.toHaveBeenCalled()
    expect(env.getUserMedia).not.toHaveBeenCalled()
  })

  it('stops the exact returned lease when cancellation arrives during start IPC', async () => {
    const env = setup()
    const startResult = deferred<Awaited<ReturnType<typeof window.toto.startInputSession>>>()
    vi.mocked(window.toto.startInputSession).mockReturnValue(startResult.promise)
    const controller = new AbortController()
    const { acquireInteractiveMic } = await import('./input-mic-admission')
    const pending = acquireInteractiveMic({ audio: true }, 'conversation', 'deliberate-talk', controller.signal)
    await vi.waitFor(() => expect(window.toto.startInputSession).toHaveBeenCalledOnce())
    controller.abort()
    startResult.resolve({ ok: true, lease })
    await expect(pending).rejects.toThrow('cancelled')
    expect(env.stopInputSession).toHaveBeenCalledExactlyOnceWith({ sessionId: lease.sessionId }, context)
    expect(env.getUserMedia).not.toHaveBeenCalled()
  })

  it('does not open the microphone if cancellation lands while capture listeners are installed', async () => {
    const env = setup()
    const controller = new AbortController()
    vi.mocked(env.mediaDevices.addEventListener).mockImplementationOnce(() => controller.abort())
    const { acquireInteractiveMic } = await import('./input-mic-admission')

    await expect(
      acquireInteractiveMic({ audio: true }, 'conversation', 'deliberate-talk', controller.signal)
    ).rejects.toThrow('cancelled')

    expect(env.getUserMedia).not.toHaveBeenCalled()
    expect(env.stopInputSession).toHaveBeenCalledExactlyOnceWith({ sessionId: lease.sessionId }, context)
  })

  it('stops a late stream and releases its exact lease after abort during getUserMedia', async () => {
    const env = setup()
    const controller = new AbortController()
    const { acquireInteractiveMic } = await import('./input-mic-admission')
    const pending = acquireInteractiveMic({ audio: true }, 'conversation', 'deliberate-talk', controller.signal)
    await vi.waitFor(() => expect(env.getUserMedia).toHaveBeenCalledOnce())
    controller.abort()
    env.capture.resolve(mediaStream(env.track))
    await expect(pending).rejects.toThrow()
    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.stopInputSession).toHaveBeenCalledOnce()
    expect(env.stopInputSession).toHaveBeenCalledWith({ sessionId: lease.sessionId }, context)
  })

  it('releases and stops a late stream after an input-device change during getUserMedia', async () => {
    const env = setup()
    const { acquireInteractiveMic } = await import('./input-mic-admission')
    const pending = acquireInteractiveMic({ audio: true }, 'conversation')
    await vi.waitFor(() => expect(env.getUserMedia).toHaveBeenCalledOnce())
    env.changeDevice()
    env.capture.resolve(mediaStream(env.track))
    await expect(pending).rejects.toThrow()
    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.stopInputSession).toHaveBeenCalledOnce()
  })

  it('stops a late stream on exact main revocation without releasing a second time', async () => {
    const env = setup()
    const { acquireInteractiveMic } = await import('./input-mic-admission')
    const pending = acquireInteractiveMic({ audio: true }, 'conversation')
    await vi.waitFor(() => expect(env.getUserMedia).toHaveBeenCalledOnce())
    env.revokeInput({ sessionId: lease.sessionId, revision: lease.revision, reason: 'auth-revoked' })
    env.capture.resolve(mediaStream(env.track))
    await expect(pending).rejects.toThrow()
    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.stopInputSession).not.toHaveBeenCalled()
  })

  it('releases an established stream and lease exactly once', async () => {
    const env = setup()
    const { acquireInteractiveMic } = await import('./input-mic-admission')
    const pending = acquireInteractiveMic({ audio: true }, 'conversation')
    await vi.waitFor(() => expect(env.getUserMedia).toHaveBeenCalledOnce())
    env.capture.resolve(mediaStream(env.track))
    const admitted = await pending
    await Promise.all([admitted.admission.release(), admitted.admission.release()])
    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.stopInputSession).toHaveBeenCalledOnce()
    expect(window.toto.confirmInputSession).toHaveBeenCalledExactlyOnceWith(lease.sessionId, context)
  })

  it('stops and releases the stream when main refuses post-capture confirmation', async () => {
    const env = setup()
    vi.mocked(window.toto.confirmInputSession).mockResolvedValue(false)
    const { acquireInteractiveMic } = await import('./input-mic-admission')
    const pending = acquireInteractiveMic({ audio: true }, 'conversation')
    await vi.waitFor(() => expect(env.getUserMedia).toHaveBeenCalledOnce())
    env.capture.resolve(mediaStream(env.track))
    await expect(pending).rejects.toThrow('confirmed by main')
    expect(window.toto.confirmInputSession).toHaveBeenCalledExactlyOnceWith(lease.sessionId, context)
    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.stopInputSession).toHaveBeenCalledOnce()
  })

  it('stops only physical media twice without ending the exact lease', async () => {
    const env = setup()
    const { acquireInteractiveMic } = await import('./input-mic-admission')
    const pending = acquireInteractiveMic({ audio: true }, 'conversation')
    await vi.waitFor(() => expect(env.getUserMedia).toHaveBeenCalledOnce())
    env.capture.resolve(mediaStream(env.track))
    const admitted = await pending

    admitted.stopMedia()
    admitted.stopMedia()
    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.stopInputSession).not.toHaveBeenCalled()

    await admitted.admission.release()
    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.stopInputSession).toHaveBeenCalledExactlyOnceWith({ sessionId: lease.sessionId }, context)
  })

  it('keeps physical stop idempotent while exact session and revision revocation ends the lease', async () => {
    const env = setup()
    const { acquireInteractiveMic } = await import('./input-mic-admission')
    const pending = acquireInteractiveMic({ audio: true }, 'conversation')
    await vi.waitFor(() => expect(env.getUserMedia).toHaveBeenCalledOnce())
    env.capture.resolve(mediaStream(env.track))
    const admitted = await pending

    admitted.stopMedia()
    env.revokeInput({ sessionId: lease.sessionId, revision: lease.revision + 1, reason: 'auth-revoked' })
    expect(admitted.admission.revoked).toBe(false)
    expect(env.stopInputSession).not.toHaveBeenCalled()
    env.revokeInput({ sessionId: lease.sessionId, revision: lease.revision, reason: 'auth-revoked' })

    expect(admitted.admission.revoked).toBe(true)
    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.stopInputSession).not.toHaveBeenCalled()
    await admitted.admission.release()
    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.stopInputSession).not.toHaveBeenCalled()
  })

  it('does not stop an already physically stopped stream again on abort release', async () => {
    const env = setup()
    const controller = new AbortController()
    const { acquireInteractiveMic } = await import('./input-mic-admission')
    const pending = acquireInteractiveMic({ audio: true }, 'conversation', 'deliberate-talk', controller.signal)
    await vi.waitFor(() => expect(env.getUserMedia).toHaveBeenCalledOnce())
    env.capture.resolve(mediaStream(env.track))
    const admitted = await pending

    admitted.stopMedia()
    controller.abort()
    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.stopInputSession).toHaveBeenCalledExactlyOnceWith({ sessionId: lease.sessionId }, context)
  })

  it('does not stop an already physically stopped stream again on device change', async () => {
    const env = setup()
    const { acquireInteractiveMic } = await import('./input-mic-admission')
    const pending = acquireInteractiveMic({ audio: true }, 'conversation')
    await vi.waitFor(() => expect(env.getUserMedia).toHaveBeenCalledOnce())
    env.capture.resolve(mediaStream(env.track))
    const admitted = await pending

    admitted.stopMedia()
    env.changeDevice()
    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.stopInputSession).toHaveBeenCalledExactlyOnceWith({ sessionId: lease.sessionId }, context)
  })

  it('keeps late confirmation from reviving media after abort', async () => {
    const env = setup()
    const controller = new AbortController()
    const confirmation = deferred<boolean>()
    vi.mocked(window.toto.confirmInputSession).mockReturnValue(confirmation.promise)
    const { acquireInteractiveMic } = await import('./input-mic-admission')
    const pending = acquireInteractiveMic({ audio: true }, 'conversation', 'deliberate-talk', controller.signal)
    await vi.waitFor(() => expect(env.getUserMedia).toHaveBeenCalledOnce())
    env.capture.resolve(mediaStream(env.track))
    await vi.waitFor(() => expect(window.toto.confirmInputSession).toHaveBeenCalledOnce())

    controller.abort()
    confirmation.resolve(true)
    await expect(pending).rejects.toThrow('confirmed by main')

    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.stopInputSession).toHaveBeenCalledExactlyOnceWith({ sessionId: lease.sessionId }, context)
    expect(window.toto.confirmInputSession).toHaveBeenCalledExactlyOnceWith(lease.sessionId, context)
  })
})

describe('meeting microphone admission lifecycle', () => {
  it('does not request capture when already cancelled and releases a grant cancelled before getUserMedia', async () => {
    const env = setup()
    const { acquireMeetingMic } = await import('./input-mic-admission')
    const alreadyCancelled = new AbortController()
    alreadyCancelled.abort()
    await expect(acquireMeetingMic({ audio: true }, 654, alreadyCancelled.signal)).rejects.toThrow('cancelled')
    expect(window.toto.meetingMicAdmission).not.toHaveBeenCalled()

    const controller = new AbortController()
    const pending = acquireMeetingMic({ audio: true }, 654, controller.signal)
    await vi.waitFor(() => expect(env.getUserMedia).toHaveBeenCalledOnce())
    controller.abort()
    env.capture.resolve(mediaStream(env.track))
    await expect(pending).rejects.toThrow()
    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.releaseMeetingMicCapture).toHaveBeenCalledExactlyOnceWith('00000000-0000-4000-8000-000000000001')
  })

  it('does not open the microphone if cancellation lands while the meeting capture listeners are installed', async () => {
    const env = setup()
    const controller = new AbortController()
    vi.mocked(env.mediaDevices.addEventListener).mockImplementationOnce(() => controller.abort())
    const { acquireMeetingMic } = await import('./input-mic-admission')

    await expect(acquireMeetingMic({ audio: true }, 654, controller.signal)).rejects.toThrow('cancelled')

    expect(env.getUserMedia).not.toHaveBeenCalled()
    expect(env.releaseMeetingMicCapture).toHaveBeenCalledExactlyOnceWith('00000000-0000-4000-8000-000000000001')
  })

  it('releases a pending meeting grant and stops its late stream on device change', async () => {
    const env = setup()
    const { acquireMeetingMic } = await import('./input-mic-admission')
    const pending = acquireMeetingMic({ audio: true }, 654)
    await vi.waitFor(() => expect(env.getUserMedia).toHaveBeenCalledOnce())
    env.changeDevice()
    env.capture.resolve(mediaStream(env.track))
    await expect(pending).rejects.toThrow()
    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.releaseMeetingMicCapture).toHaveBeenCalledExactlyOnceWith('00000000-0000-4000-8000-000000000001')
  })

  it('stops a late meeting stream after revocation during getUserMedia', async () => {
    const env = setup()
    const { acquireMeetingMic } = await import('./input-mic-admission')
    const pending = acquireMeetingMic({ audio: true }, 654)
    await vi.waitFor(() => expect(env.getUserMedia).toHaveBeenCalledOnce())
    env.revokeMeeting({ captureId: '00000000-0000-4000-8000-000000000001', startedAt: 654, reason: 'owner-replaced' })
    env.capture.resolve(mediaStream(env.track))
    await expect(pending).rejects.toThrow()
    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.releaseMeetingMicCapture).not.toHaveBeenCalled()
  })

  it('releases an established meeting stream and exact grant exactly once', async () => {
    const env = setup()
    const { acquireMeetingMic } = await import('./input-mic-admission')
    const pending = acquireMeetingMic({ audio: true }, 654)
    await vi.waitFor(() => expect(env.getUserMedia).toHaveBeenCalledOnce())
    env.capture.resolve(mediaStream(env.track))
    const admitted = await pending
    await Promise.all([admitted.release(), admitted.release()])
    expect(env.track.stop).toHaveBeenCalledOnce()
    expect(env.releaseMeetingMicCapture).toHaveBeenCalledExactlyOnceWith('00000000-0000-4000-8000-000000000001')
  })
})
