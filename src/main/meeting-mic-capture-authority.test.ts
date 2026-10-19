import { describe, expect, it, vi } from 'vitest'
import type { InputSessionContext, InputSessionStopReason } from '@shared/input-session'
import { MeetingMicCaptureAuthority } from './meeting-mic-capture-authority'

const context: InputSessionContext = { authSessionGeneration: 7, contextRevision: 12 }
const currentState = () => ({
  mainWebContentsId: 41 as number | null,
  isWindowVisible: true,
  isAuthenticated: true,
  currentUrl: 'https://metis.example/app/index.html',
  context: { ...context },
  meetingStartedAt: 654 as number | null
})
const topFrame = () => ({ webContentsId: 41, isTopFrame: true, url: 'https://metis.example/app/index.html' })
const captureA = '00000000-0000-4000-8000-000000000001'
const captureB = '00000000-0000-4000-8000-000000000002'

function setup() {
  let current = currentState()
  const onRevoked = vi.fn((_owner: unknown, _reason: InputSessionStopReason) => {})
  let nextCaptureId = captureA
  const authority = new MeetingMicCaptureAuthority({
    currentState: () => current,
    createCaptureId: () => {
      const id = nextCaptureId
      nextCaptureId = captureB
      return id
    },
    onRevoked
  })
  return {
    authority,
    onRevoked,
    setCurrent(update: Partial<ReturnType<typeof currentState>>) {
      current = { ...current, ...update }
    },
    setNextCaptureId(id: string) {
      nextCaptureId = id
    }
  }
}

describe('MeetingMicCaptureAuthority', () => {
  it('admits only the exact current visible authenticated top frame and reserved meeting', () => {
    const env = setup()
    expect(env.authority.admit(topFrame(), 654)).toEqual({ captureId: captureA, startedAt: 654 })

    const wrongSender = setup()
    expect(wrongSender.authority.admit({ ...topFrame(), webContentsId: 42 }, 654)).toBeNull()
    const childFrame = setup()
    expect(childFrame.authority.admit({ ...topFrame(), isTopFrame: false }, 654)).toBeNull()
    const staleUrl = setup()
    expect(staleUrl.authority.admit({ ...topFrame(), url: 'https://metis.example/old.html' }, 654)).toBeNull()
    const hidden = setup()
    hidden.setCurrent({ isWindowVisible: false })
    expect(hidden.authority.admit(topFrame(), 654)).toBeNull()
    const unauthenticated = setup()
    unauthenticated.setCurrent({ isAuthenticated: false })
    expect(unauthenticated.authority.admit(topFrame(), 654)).toBeNull()
    const staleReservation = setup()
    staleReservation.setCurrent({ meetingStartedAt: 655 })
    expect(staleReservation.authority.admit(topFrame(), 654)).toBeNull()
    const noReservation = setup()
    noReservation.setCurrent({ meetingStartedAt: null })
    expect(noReservation.authority.admit(topFrame(), 654)).toBeNull()
  })

  it('confirms only the exact pending capture under the unchanged sender, meeting, context, and URL', () => {
    const env = setup()
    const grant = env.authority.admit(topFrame(), 654)
    expect(grant).not.toBeNull()
    expect(env.authority.confirm(topFrame(), captureA, 654)).toBe(false)
    expect(env.authority.claimPermissionRequest(topFrame())).toBe(true)
    expect(env.authority.confirm(topFrame(), captureA, 654)).toBe(true)
    expect(env.authority.confirm(topFrame(), captureA, 654)).toBe(false)

    const wrongSender = setup()
    wrongSender.authority.admit(topFrame(), 654)
    expect(wrongSender.authority.claimPermissionRequest(topFrame())).toBe(true)
    expect(wrongSender.authority.confirm({ ...topFrame(), webContentsId: 42 }, captureA, 654)).toBe(false)
    const wrongMeeting = setup()
    wrongMeeting.authority.admit(topFrame(), 654)
    expect(wrongMeeting.authority.claimPermissionRequest(topFrame())).toBe(true)
    expect(wrongMeeting.authority.confirm(topFrame(), captureA, 655)).toBe(false)
    const replacedMeeting = setup()
    replacedMeeting.authority.admit(topFrame(), 654)
    expect(replacedMeeting.authority.claimPermissionRequest(topFrame())).toBe(true)
    replacedMeeting.setCurrent({ meetingStartedAt: 655 })
    expect(replacedMeeting.authority.confirm(topFrame(), captureA, 654)).toBe(false)
    const staleContext = setup()
    staleContext.authority.admit(topFrame(), 654)
    expect(staleContext.authority.claimPermissionRequest(topFrame())).toBe(true)
    staleContext.setCurrent({ context: { authSessionGeneration: 8, contextRevision: 12 } })
    expect(staleContext.authority.confirm(topFrame(), captureA, 654)).toBe(false)
    const staleUrl = setup()
    staleUrl.authority.admit(topFrame(), 654)
    expect(staleUrl.authority.claimPermissionRequest(topFrame())).toBe(true)
    staleUrl.setCurrent({ currentUrl: 'https://metis.example/app/reloaded.html' })
    expect(staleUrl.authority.confirm(topFrame(), captureA, 654)).toBe(false)
  })

  it('allows exactly one unresolved admission and atomically consumes one exact permission claim', () => {
    const env = setup()
    expect(env.authority.admit(topFrame(), 654)).toEqual({ captureId: captureA, startedAt: 654 })
    expect(env.authority.admit(topFrame(), 654)).toBeNull()
    expect(env.authority.hasPermissionRequestOwner(41, 654, context, 'https://metis.example/app/index.html')).toBe(true)
    expect(env.authority.hasPermissionCheckOwner(41, 654, context, 'https://metis.example/app/index.html')).toBe(false)
    expect(env.authority.claimPermissionRequest(topFrame())).toBe(true)
    expect(env.authority.hasPermissionCheckOwner(41, 654, context, 'https://metis.example/app/index.html')).toBe(true)
    expect(env.authority.claimPermissionRequest(topFrame())).toBe(false)
    expect(env.authority.admit(topFrame(), 654)).toBeNull()
  })

  it('claims only for the current visible authenticated top frame and exact meeting context', () => {
    const wrongFrame = setup()
    wrongFrame.authority.admit(topFrame(), 654)
    expect(wrongFrame.authority.claimPermissionRequest({ ...topFrame(), isTopFrame: false })).toBe(false)
    expect(wrongFrame.authority.claimPermissionRequest({ ...topFrame(), webContentsId: 42 })).toBe(false)
    expect(wrongFrame.authority.claimPermissionRequest({ ...topFrame(), url: 'https://metis.example/other' })).toBe(
      false
    )
    expect(wrongFrame.authority.claimPermissionRequest(topFrame())).toBe(true)

    const hidden = setup()
    hidden.authority.admit(topFrame(), 654)
    hidden.setCurrent({ isWindowVisible: false })
    expect(hidden.authority.claimPermissionRequest(topFrame())).toBe(false)

    const unauthenticated = setup()
    unauthenticated.authority.admit(topFrame(), 654)
    unauthenticated.setCurrent({ isAuthenticated: false })
    expect(unauthenticated.authority.claimPermissionRequest(topFrame())).toBe(false)

    const staleContext = setup()
    staleContext.authority.admit(topFrame(), 654)
    staleContext.setCurrent({ context: { authSessionGeneration: 8, contextRevision: 12 } })
    expect(staleContext.authority.claimPermissionRequest(topFrame())).toBe(false)

    const staleMeeting = setup()
    staleMeeting.authority.admit(topFrame(), 654)
    staleMeeting.setCurrent({ meetingStartedAt: 655 })
    expect(staleMeeting.authority.claimPermissionRequest(topFrame())).toBe(false)
  })

  it('releases only the exact sender-owned id, even after its meeting reservation changes', () => {
    const env = setup()
    env.authority.admit(topFrame(), 654)
    env.setCurrent({ meetingStartedAt: 655, isWindowVisible: false, isAuthenticated: false })
    expect(env.authority.release(42, captureA)).toBe(false)
    expect(env.authority.release(41, captureB)).toBe(false)
    expect(env.authority.hasPermissionRequestOwner(41, 654, context, 'https://metis.example/app/index.html')).toBe(true)
    expect(env.authority.release(41, captureA)).toBe(true)
    expect(env.authority.release(41, captureA)).toBe(false)
    expect(env.onRevoked).not.toHaveBeenCalled()
  })

  it('revokes pending grants on hide and preserves established meeting streams', () => {
    const env = setup()
    env.authority.admit(topFrame(), 654)
    expect(env.authority.claimPermissionRequest(topFrame())).toBe(true)
    expect(env.authority.confirm(topFrame(), captureA, 654)).toBe(true)
    env.setNextCaptureId(captureB)
    env.authority.admit(topFrame(), 654)
    expect(env.authority.claimPermissionRequest(topFrame())).toBe(true)

    env.authority.revokePending('window-hidden')

    expect(env.onRevoked).toHaveBeenCalledTimes(1)
    expect(env.onRevoked).toHaveBeenCalledWith(
      expect.objectContaining({ captureId: captureB, startedAt: 654, state: 'permission-authorized' }),
      'window-hidden'
    )
    expect(env.authority.release(41, captureA)).toBe(true)
    expect(env.onRevoked).toHaveBeenCalledTimes(1)
  })

  it('rejects a second capture while an established grant remains and admits after exact release', () => {
    const env = setup()
    expect(env.authority.admit(topFrame(), 654)).toEqual({ captureId: captureA, startedAt: 654 })
    expect(env.authority.claimPermissionRequest(topFrame())).toBe(true)
    expect(env.authority.confirm(topFrame(), captureA, 654)).toBe(true)
    expect(env.authority.admit(topFrame(), 654)).toBeNull()

    expect(env.authority.release(41, captureA)).toBe(true)
    env.setNextCaptureId(captureB)
    expect(env.authority.admit(topFrame(), 654)).toEqual({ captureId: captureB, startedAt: 654 })
  })

  it('keeps an established physical meeting owner exclusive across context revisions until exact release', () => {
    const env = setup()
    expect(env.authority.admit(topFrame(), 654)).toEqual({ captureId: captureA, startedAt: 654 })
    expect(env.authority.claimPermissionRequest(topFrame())).toBe(true)
    expect(env.authority.confirm(topFrame(), captureA, 654)).toBe(true)

    env.setCurrent({ context: { authSessionGeneration: 7, contextRevision: 10 } })
    expect(env.authority.admit(topFrame(), 654)).toBeNull()

    expect(env.authority.release(41, captureA)).toBe(true)
    env.setNextCaptureId(captureB)
    expect(env.authority.admit(topFrame(), 654)).toEqual({ captureId: captureB, startedAt: 654 })
  })

  it('revokes only grants belonging to the replaced meeting', () => {
    const env = setup()
    env.authority.admit(topFrame(), 654)
    env.setCurrent({ meetingStartedAt: 655 })
    env.authority.admit(topFrame(), 655)

    env.authority.revokeMeeting(654, 'owner-replaced')

    expect(env.onRevoked).toHaveBeenCalledTimes(1)
    expect(env.onRevoked).toHaveBeenCalledWith(
      expect.objectContaining({ captureId: captureA, startedAt: 654 }),
      'owner-replaced'
    )
    expect(env.authority.release(41, captureB)).toBe(true)
  })
})
