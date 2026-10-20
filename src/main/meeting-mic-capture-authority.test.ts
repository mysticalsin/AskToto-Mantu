import { describe, expect, it, vi } from 'vitest'
import type { InputSessionContext, InputSessionStopReason } from '@shared/input-session'
import { MeetingMicCaptureAuthority, bindMeetingMicRendererReset } from './meeting-mic-capture-authority'

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
    const established = setup()
    expect(established.authority.admit(topFrame(), 654)).toEqual({ captureId: captureA, startedAt: 654 })
    expect(established.authority.claimPermissionRequest(topFrame())).toBe(true)
    expect(established.authority.confirm(topFrame(), captureA, 654)).toBe(true)

    const pending = setup()
    pending.setNextCaptureId(captureB)
    expect(pending.authority.admit(topFrame(), 654)).toEqual({ captureId: captureB, startedAt: 654 })
    expect(pending.authority.claimPermissionRequest(topFrame())).toBe(true)
    expect(pending.authority.hasPermissionCheckOwner(41, 654, context, 'https://metis.example/app/index.html')).toBe(
      true
    )

    pending.setCurrent({ isWindowVisible: false })
    pending.authority.revokePending('window-hidden')

    expect(pending.onRevoked).toHaveBeenCalledTimes(1)
    expect(pending.onRevoked).toHaveBeenCalledWith(
      expect.objectContaining({ captureId: captureB, startedAt: 654, state: 'permission-authorized' }),
      'window-hidden'
    )
    pending.setCurrent({ isWindowVisible: true })
    expect(pending.authority.hasPermissionRequestOwner(41, 654, context, 'https://metis.example/app/index.html')).toBe(
      false
    )
    expect(pending.authority.hasPermissionCheckOwner(41, 654, context, 'https://metis.example/app/index.html')).toBe(
      false
    )
    expect(pending.authority.claimPermissionRequest(topFrame())).toBe(false)
    expect(pending.authority.confirm(topFrame(), captureB, 654)).toBe(false)
    expect(pending.authority.release(41, captureB)).toBe(false)
    pending.authority.revokePending('window-hidden')
    expect(pending.onRevoked).toHaveBeenCalledTimes(1)

    established.setCurrent({ isWindowVisible: false })
    established.authority.revokePending('window-hidden')
    expect(established.onRevoked).not.toHaveBeenCalled()
    expect(established.authority.release(41, captureA)).toBe(true)
    expect(established.authority.release(41, captureA)).toBe(false)
    expect(established.onRevoked).not.toHaveBeenCalled()
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

  it('revokes a pre-permission pending capture on hide', () => {
    const env = setup()
    expect(env.authority.admit(topFrame(), 654)).toEqual({ captureId: captureA, startedAt: 654 })
    expect(env.authority.hasPermissionRequestOwner(41, 654, context, 'https://metis.example/app/index.html')).toBe(true)

    env.setCurrent({ isWindowVisible: false })
    env.authority.revokePending('window-hidden')

    expect(env.onRevoked).toHaveBeenCalledTimes(1)
    expect(env.onRevoked).toHaveBeenCalledWith(
      expect.objectContaining({ captureId: captureA, startedAt: 654, state: 'pending' }),
      'window-hidden'
    )
    env.setCurrent({ isWindowVisible: true })
    expect(env.authority.hasPermissionRequestOwner(41, 654, context, 'https://metis.example/app/index.html')).toBe(
      false
    )
    expect(env.authority.hasPermissionCheckOwner(41, 654, context, 'https://metis.example/app/index.html')).toBe(false)
    expect(env.authority.claimPermissionRequest(topFrame())).toBe(false)
    expect(env.authority.confirm(topFrame(), captureA, 654)).toBe(false)
    expect(env.authority.release(41, captureA)).toBe(false)
    env.authority.revokePending('window-hidden')
    expect(env.onRevoked).toHaveBeenCalledTimes(1)
  })

  it('refuses confirmation once the window hides, auth clears, or the context revision advances', () => {
    for (const update of [
      { isWindowVisible: false },
      { isAuthenticated: false },
      { context: { authSessionGeneration: 7, contextRevision: 13 } }
    ]) {
      const env = setup()
      expect(env.authority.admit(topFrame(), 654)).toEqual({ captureId: captureA, startedAt: 654 })
      expect(env.authority.claimPermissionRequest(topFrame())).toBe(true)
      env.setCurrent(update)
      expect(env.authority.confirm(topFrame(), captureA, 654)).toBe(false)
      expect(env.authority.hasPermissionCheckOwner(41, 654, context, 'https://metis.example/app/index.html')).toBe(true)
    }
  })

  it('binds an admitted grant to the admitting context and URL', () => {
    const env = setup()
    env.authority.admit(topFrame(), 654)
    const url = 'https://metis.example/app/index.html'
    expect(env.authority.hasPermissionRequestOwner(41, 654, context, url)).toBe(true)
    expect(env.authority.hasPermissionRequestOwner(41, 654, { ...context, authSessionGeneration: 8 }, url)).toBe(false)
    expect(env.authority.hasPermissionRequestOwner(41, 654, { ...context, contextRevision: 13 }, url)).toBe(false)
    expect(env.authority.hasPermissionRequestOwner(41, 654, context, 'https://metis.example/other')).toBe(false)
    expect(env.authority.hasPermissionRequestOwner(42, 654, context, url)).toBe(false)
    expect(env.authority.hasPermissionRequestOwner(41, 655, context, url)).toBe(false)
    expect(env.authority.hasPermissionRequestOwner(41, null, context, url)).toBe(false)
  })

  it('releases without consulting or changing the meeting reservation', () => {
    let readable = true
    const state = currentState()
    const currentStateReader = vi.fn(() => {
      if (!readable) throw new Error('release must not read the meeting reservation')
      return state
    })
    const onRevoked = vi.fn()
    const authority = new MeetingMicCaptureAuthority({
      currentState: currentStateReader,
      createCaptureId: () => captureA,
      onRevoked
    })
    expect(authority.admit(topFrame(), 654)).toEqual({ captureId: captureA, startedAt: 654 })
    readable = false
    const readsBefore = currentStateReader.mock.calls.length
    expect(authority.release(42, captureA)).toBe(false)
    expect(authority.release(41, captureA)).toBe(true)
    expect(currentStateReader.mock.calls.length).toBe(readsBefore)
    expect(onRevoked).not.toHaveBeenCalled()
    expect(state.meetingStartedAt).toBe(654)
  })

  function establish(authority: MeetingMicCaptureAuthority) {
    expect(authority.admit(topFrame(), 654)).toEqual({ captureId: captureA, startedAt: 654 })
    expect(authority.claimPermissionRequest(topFrame())).toBe(true)
    expect(authority.confirm(topFrame(), captureA, 654)).toBe(true)
  }

  it('revokePending preserves an established owner', () => {
    const { authority, onRevoked } = setup()
    establish(authority)
    authority.revokePending('owner-replaced')
    expect(onRevoked).not.toHaveBeenCalled()
    expect(authority.release(41, captureA)).toBe(true)
  })

  it('revokePending revokes a permission-authorized owner', () => {
    const { authority, onRevoked } = setup()
    expect(authority.admit(topFrame(), 654)).toEqual({ captureId: captureA, startedAt: 654 })
    expect(authority.claimPermissionRequest(topFrame())).toBe(true)
    authority.revokePending('owner-replaced')
    expect(onRevoked).toHaveBeenCalledTimes(1)
    expect(onRevoked).toHaveBeenCalledWith(
      expect.objectContaining({ captureId: captureA, state: 'permission-authorized' }),
      'owner-replaced'
    )
    expect(authority.release(41, captureA)).toBe(false)
  })

  it('renderer reset frees the physical owner', () => {
    const { authority, onRevoked } = setup()
    establish(authority)
    authority.revokeWebContents(41, 'renderer-reset')
    expect(onRevoked).toHaveBeenCalledTimes(1)
    expect(onRevoked).toHaveBeenCalledWith(
      expect.objectContaining({ captureId: captureA, state: 'established' }),
      'renderer-reset'
    )
    expect(authority.release(41, captureA)).toBe(false)
    expect(authority.admit(topFrame(), 654)).toEqual({ captureId: captureB, startedAt: 654 })
  })

  it('revokeWebContents does not touch other webContents', () => {
    const { authority, onRevoked, setCurrent } = setup()
    expect(authority.admit(topFrame(), 654)).toEqual({ captureId: captureA, startedAt: 654 })
    setCurrent({ mainWebContentsId: 42 })
    expect(authority.admit({ ...topFrame(), webContentsId: 42 }, 654)).toEqual({
      captureId: captureB,
      startedAt: 654
    })
    authority.revokeWebContents(42, 'renderer-reset')
    expect(onRevoked).toHaveBeenCalledTimes(1)
    expect(onRevoked).toHaveBeenCalledWith(expect.objectContaining({ captureId: captureB }), 'renderer-reset')
    expect(authority.release(41, captureA)).toBe(true)
  })

  it('rejects a second capture after a context revision change while established', () => {
    const { authority, setCurrent } = setup()
    establish(authority)
    setCurrent({ context: { authSessionGeneration: 7, contextRevision: 13 } })
    expect(authority.admit(topFrame(), 654)).toBeNull()
    expect(authority.release(41, captureA)).toBe(true)
    expect(authority.admit(topFrame(), 654)).toEqual({ captureId: captureB, startedAt: 654 })
  })
})

describe('bindMeetingMicRendererReset', () => {
  type Listener = (...args: unknown[]) => void

  function fakeContents(id: number) {
    const listeners = new Map<string, Listener[]>()
    let idReadable = true
    return {
      get id(): number {
        if (!idReadable) throw new Error('id read after destruction')
        return id
      },
      on(event: string, listener: (...args: never[]) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener as Listener])
        return this
      },
      emit(event: string, ...args: unknown[]) {
        for (const listener of listeners.get(event) ?? []) listener(...args)
      },
      makeIdUnreadable() {
        idReadable = false
      }
    }
  }

  it('revokes the bound webContents on render-process-gone and destroyed', () => {
    const contents = fakeContents(41)
    const authority = { revokeWebContents: vi.fn() }
    bindMeetingMicRendererReset(contents, authority)
    contents.emit('render-process-gone')
    contents.emit('destroyed')
    expect(authority.revokeWebContents).toHaveBeenCalledTimes(2)
    expect(authority.revokeWebContents).toHaveBeenNthCalledWith(1, 41, 'renderer-reset')
    expect(authority.revokeWebContents).toHaveBeenNthCalledWith(2, 41, 'renderer-reset')
  })

  it('revokes on a main-frame cross-document navigation only', () => {
    const contents = fakeContents(41)
    const authority = { revokeWebContents: vi.fn() }
    bindMeetingMicRendererReset(contents, authority)
    const url = 'https://metis.example/app/index.html'
    contents.emit('did-start-navigation', {}, url, true, true)
    contents.emit('did-start-navigation', {}, url, false, false)
    expect(authority.revokeWebContents).not.toHaveBeenCalled()
    contents.emit('did-start-navigation', {}, url, false, true)
    expect(authority.revokeWebContents).toHaveBeenCalledTimes(1)
    expect(authority.revokeWebContents).toHaveBeenCalledWith(41, 'renderer-reset')
  })

  it('uses the id captured at bind time', () => {
    const contents = fakeContents(41)
    const authority = { revokeWebContents: vi.fn() }
    bindMeetingMicRendererReset(contents, authority)
    contents.makeIdUnreadable()
    expect(() => contents.emit('destroyed')).not.toThrow()
    expect(authority.revokeWebContents).toHaveBeenCalledWith(41, 'renderer-reset')
  })
})
