import { describe, expect, it, vi } from 'vitest'
import { createListeningStateHandler } from './listening-state-ipc'

function harness(
  releaseParakeet: () => Promise<void>,
  releaseSpeakerEmbedding: () => Promise<unknown> = async () => undefined
) {
  const deps = {
    assertMainWindow: vi.fn(),
    requireAuth: vi.fn(() => true),
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
