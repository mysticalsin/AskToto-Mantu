import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/ipc'
import { MEETING_START_ACTION } from '../meeting-start-activation-authority'
import { type MeetingMicIpcDependencies, registerMeetingMicIpc } from './meeting-mic-ipc'

type Handler = (event: IpcMainInvokeEvent, raw?: unknown) => unknown

const captureId = '00000000-0000-4000-8000-000000000001'
const activationFrame = { webContentsId: 41, frameId: '1:2', isTopFrame: true, url: 'file:///index.html' }

function invokeEvent(options: { frame?: boolean; parent?: unknown } = {}): IpcMainInvokeEvent {
  return {
    sender: { id: 41 },
    senderFrame:
      options.frame === false
        ? null
        : { parent: options.parent ?? null, url: 'file:///index.html', processId: 1, routingId: 2 }
  } as unknown as IpcMainInvokeEvent
}

function setup(overrides: Partial<MeetingMicIpcDependencies> = {}) {
  const handlers = new Map<string, Handler>()
  const order: string[] = []
  const deps: MeetingMicIpcDependencies = {
    ipcMain: {
      handle: (channel: string, handler: unknown) => {
        handlers.set(channel, handler as Handler)
      }
    } as unknown as Pick<IpcMain, 'handle'>,
    assertMainWindow: vi.fn(() => {
      order.push('assert')
    }),
    requireAuth: vi.fn(() => true),
    isInputClosing: () => false,
    isCaptureLifecycleReady: () => true,
    isMainWindowVisible: () => true,
    activationFrameFromEvent: vi.fn(() => activationFrame),
    activation: {
      mint: vi.fn(() => {
        order.push('mint')
        return true
      }),
      hasPending: vi.fn(() => true),
      revokeAll: vi.fn()
    },
    capture: {
      admit: vi.fn(() => {
        order.push('admit')
        return { captureId, startedAt: 654 }
      }),
      confirm: vi.fn(() => true),
      release: vi.fn(() => {
        order.push('release')
        return true
      })
    },
    ...overrides
  }
  registerMeetingMicIpc(deps)
  const handler = (channel: string): Handler => {
    const found = handlers.get(channel)
    if (!found) throw new Error(`missing handler ${channel}`)
    return found
  }
  return { deps, handler, order }
}

describe('meeting microphone admission IPC', () => {
  it('asserts the main window before admitting the exact top-frame sender for the requested meeting', () => {
    const { deps, handler, order } = setup()
    expect(handler(IPC.meetingMicAdmission)(invokeEvent(), { startedAt: 654 })).toEqual({ captureId, startedAt: 654 })
    expect(deps.capture.admit).toHaveBeenCalledWith(
      { webContentsId: 41, isTopFrame: true, url: 'file:///index.html' },
      654
    )
    expect(order).toEqual(['assert', 'admit'])
  })

  it('reports a child frame as non-top to the authority', () => {
    const { deps, handler } = setup()
    handler(IPC.meetingMicAdmission)(invokeEvent({ parent: {} }), { startedAt: 654 })
    expect(deps.capture.admit).toHaveBeenCalledWith(expect.objectContaining({ isTopFrame: false }), 654)
  })

  it('admits nothing while closing, before power lifecycle hooks are ready, without a frame, or for a bad payload', () => {
    for (const overrides of [{ isInputClosing: () => true }, { isCaptureLifecycleReady: () => false }]) {
      const { deps, handler } = setup(overrides)
      expect(handler(IPC.meetingMicAdmission)(invokeEvent(), { startedAt: 654 })).toBeNull()
      expect(deps.capture.admit).not.toHaveBeenCalled()
    }
    const noFrame = setup()
    expect(noFrame.handler(IPC.meetingMicAdmission)(invokeEvent({ frame: false }), { startedAt: 654 })).toBeNull()
    const badPayload = setup()
    expect(badPayload.handler(IPC.meetingMicAdmission)(invokeEvent(), { startedAt: 654, extra: 1 })).toBeNull()
    expect(badPayload.deps.capture.admit).not.toHaveBeenCalled()
  })

  it('propagates a main-window assertion failure without admitting', () => {
    const { deps, handler } = setup({
      assertMainWindow: () => {
        throw new Error('not main window')
      }
    })
    expect(() => handler(IPC.meetingMicAdmission)(invokeEvent(), { startedAt: 654 })).toThrow('not main window')
    expect(deps.capture.admit).not.toHaveBeenCalled()
  })

  it('confirms the exact capture id and meeting for the sender frame, and refuses while closing', () => {
    const { deps, handler } = setup()
    expect(handler(IPC.meetingMicCaptureConfirm)(invokeEvent(), { captureId, startedAt: 654 })).toBe(true)
    expect(deps.capture.confirm).toHaveBeenCalledWith(
      { webContentsId: 41, isTopFrame: true, url: 'file:///index.html' },
      captureId,
      654
    )
    const closing = setup({ isInputClosing: () => true })
    expect(closing.handler(IPC.meetingMicCaptureConfirm)(invokeEvent(), { captureId, startedAt: 654 })).toBe(false)
    expect(closing.deps.capture.confirm).not.toHaveBeenCalled()
    const malformed = setup()
    expect(malformed.handler(IPC.meetingMicCaptureConfirm)(invokeEvent(), { captureId: 'x', startedAt: 654 })).toBe(
      false
    )
    expect(malformed.deps.capture.confirm).not.toHaveBeenCalled()
  })

  it('limits release to the sender id and exact capture id, even while closing', () => {
    const { deps, handler, order } = setup({ isInputClosing: () => true, isCaptureLifecycleReady: () => false })
    expect(handler(IPC.meetingMicCaptureRelease)(invokeEvent(), { captureId })).toBe(true)
    expect(deps.capture.release).toHaveBeenCalledWith(41, captureId)
    expect(order).toEqual(['assert', 'release'])
    expect(handler(IPC.meetingMicCaptureRelease)(invokeEvent(), { captureId, startedAt: 654 })).toBe(false)
    expect(deps.capture.release).toHaveBeenCalledTimes(1)
  })
})

describe('meeting-start activation IPC', () => {
  it('asserts the main window before minting a meeting-start grant for the sender frame', () => {
    const { deps, handler, order } = setup()
    expect(handler(IPC.meetingStartActivationObserved)(invokeEvent())).toBe(true)
    expect(deps.activation.mint).toHaveBeenCalledWith(activationFrame, MEETING_START_ACTION)
    expect(order).toEqual(['assert', 'mint'])
  })

  it('mints and reports nothing when signed out, closing, or hidden', () => {
    for (const overrides of [
      { requireAuth: () => false },
      { isInputClosing: () => true },
      { isMainWindowVisible: () => false }
    ]) {
      const { deps, handler } = setup(overrides)
      expect(handler(IPC.meetingStartActivationObserved)(invokeEvent())).toBe(false)
      expect(handler(IPC.meetingStartActivationReady)(invokeEvent())).toBe(false)
      expect(deps.activation.mint).not.toHaveBeenCalled()
      expect(deps.activation.hasPending).not.toHaveBeenCalled()
    }
  })

  it('checks auth before closing or visibility state', () => {
    const isInputClosing = vi.fn(() => false)
    const { handler } = setup({ requireAuth: () => false, isInputClosing })
    handler(IPC.meetingStartActivationObserved)(invokeEvent())
    expect(isInputClosing).not.toHaveBeenCalled()
  })

  it('reports readiness from the pending grant for the sender frame', () => {
    const { deps, handler } = setup()
    expect(handler(IPC.meetingStartActivationReady)(invokeEvent())).toBe(true)
    expect(deps.activation.hasPending).toHaveBeenCalledWith(activationFrame)
    const noFrame = setup({ activationFrameFromEvent: () => null })
    expect(noFrame.handler(IPC.meetingStartActivationReady)(invokeEvent())).toBe(false)
    expect(noFrame.handler(IPC.meetingStartActivationObserved)(invokeEvent())).toBe(false)
  })

  it('cancels only when the sender frame holds a pending grant', () => {
    const { deps, handler } = setup({ requireAuth: () => false, isMainWindowVisible: () => false })
    expect(handler(IPC.meetingStartActivationCancel)(invokeEvent())).toBe(true)
    expect(deps.activation.revokeAll).toHaveBeenCalledOnce()

    const none = setup()
    vi.mocked(none.deps.activation.hasPending).mockReturnValue(false)
    expect(none.handler(IPC.meetingStartActivationCancel)(invokeEvent())).toBe(false)
    expect(none.deps.activation.revokeAll).not.toHaveBeenCalled()

    const noFrame = setup({ activationFrameFromEvent: () => null })
    expect(noFrame.handler(IPC.meetingStartActivationCancel)(invokeEvent())).toBe(false)
    expect(noFrame.deps.activation.revokeAll).not.toHaveBeenCalled()
  })
})
