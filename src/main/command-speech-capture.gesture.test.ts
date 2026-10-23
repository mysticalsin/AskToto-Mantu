import { describe, expect, it, vi } from 'vitest'
import type { TrustedInputOwner } from '@shared/input-session'
import { CommandSpeechCapture } from './command-speech-capture'

const owner: TrustedInputOwner = {
  webContentsId: 7,
  frameId: '12:3',
  isTopFrame: true,
  authSessionGeneration: 5,
  contextRevision: 11
}

function make(current: boolean, onStarted: (o: TrustedInputOwner, id: string) => void) {
  return new CommandSpeechCapture({
    isCurrent: () => current,
    transcribe: async () => '',
    ingestTranscript: () => undefined,
    onStarted
  })
}

describe('CommandSpeechCapture gesture start (G34)', () => {
  it('tells main the gesture began, with the main-minted owner and session, only after the start is accepted', () => {
    const onStarted = vi.fn()
    const capture = make(true, onStarted)
    expect(capture.start(owner, 'session-1')).toEqual({ ok: true })
    expect(onStarted).toHaveBeenCalledWith(owner, 'session-1')
    capture.cancelAll()
  })

  it('binds nothing for a stale start', () => {
    const onStarted = vi.fn()
    expect(make(false, onStarted).start(owner, 'session-1')).toEqual({ ok: false, reason: 'stale' })
    expect(onStarted).not.toHaveBeenCalled()
  })

  it('a throwing binder never blocks the capture', () => {
    const capture = make(true, () => {
      throw new Error('boom')
    })
    expect(capture.start(owner, 'session-1')).toEqual({ ok: true })
    capture.cancelAll()
  })
})
