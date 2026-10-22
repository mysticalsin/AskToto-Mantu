import { beforeEach, describe, expect, it } from 'vitest'
import {
  type CommandMicActivationFrame,
  CommandMicActivationAuthority,
  type CommandMicActivationState,
  commandMicOwner
} from './command-mic-activation-authority'

const URL = 'app://metis/index.html'

function baseState(): CommandMicActivationState {
  return {
    mainWebContentsId: 7,
    mainFrameId: '12:3',
    currentUrl: URL,
    isWindowVisible: true,
    isAuthenticated: true,
    isParakeetSelected: true,
    context: { authSessionGeneration: 5, contextRevision: 11 }
  }
}

const frame: CommandMicActivationFrame = { webContentsId: 7, frameId: '12:3', isTopFrame: true, url: URL }

describe('CommandMicActivationAuthority', () => {
  let s: CommandMicActivationState
  let t: number

  beforeEach(() => {
    s = baseState()
    t = 1_000
  })

  function makeAuthority(ttlMs?: number): CommandMicActivationAuthority {
    return new CommandMicActivationAuthority({ state: () => s, now: () => t, ttlMs })
  }

  it('mint then consume succeeds exactly once', () => {
    const auth = makeAuthority()
    expect(auth.mint(frame)).toBe(true)
    expect(auth.hasPending(frame)).toBe(true)
    expect(auth.consume(frame)).toBe(true)
    expect(auth.consume(frame)).toBe(false)
  })

  it('refuses replay of a consumed activation', () => {
    const auth = makeAuthority()
    expect(auth.mint(frame)).toBe(true)
    expect(auth.consume(frame)).toBe(true)
    expect(auth.consume(frame)).toBe(false)
    expect(auth.hasPending(frame)).toBe(false)
    // A second mint is a new user click and is allowed.
    expect(auth.mint(frame)).toBe(true)
    expect(auth.consume(frame)).toBe(true)
    expect(auth.consume(frame)).toBe(false)
  })

  it('hasPending is false after revokeAll', () => {
    const auth = makeAuthority()
    expect(auth.mint(frame)).toBe(true)
    expect(auth.hasPending(frame)).toBe(true)
    auth.revokeAll()
    expect(auth.hasPending(frame)).toBe(false)
    expect(auth.consume(frame)).toBe(false)
  })

  it('refuses consume from a different command lease', () => {
    const contextAdvance = makeAuthority()
    expect(contextAdvance.mint(frame)).toBe(true)
    s = { ...s, context: { authSessionGeneration: 5, contextRevision: 12 } }
    expect(contextAdvance.consume(frame)).toBe(false)

    s = baseState()
    const authAdvance = makeAuthority()
    expect(authAdvance.mint(frame)).toBe(true)
    s = { ...s, context: { authSessionGeneration: 6, contextRevision: 11 } }
    expect(authAdvance.consume(frame)).toBe(false)

    s = baseState()
    const otherFrame = makeAuthority()
    expect(otherFrame.mint(frame)).toBe(true)
    expect(otherFrame.consume({ ...frame, frameId: '12:4' })).toBe(false)
    expect(otherFrame.consume(frame)).toBe(true)
  })

  it('expires after the ttl', () => {
    const auth = makeAuthority(100)
    expect(auth.mint(frame)).toBe(true)
    t += 100
    expect(auth.hasPending(frame)).toBe(false)
    expect(auth.consume(frame)).toBe(false)

    t = 1_000
    const control = makeAuthority(100)
    expect(control.mint(frame)).toBe(true)
    t += 99
    expect(control.consume(frame)).toBe(true)
  })

  it('mint refuses a hidden, signed-out or non-parakeet state', () => {
    const patches: Array<Partial<CommandMicActivationState>> = [
      { isWindowVisible: false },
      { isAuthenticated: false },
      { isParakeetSelected: false }
    ]
    for (const patch of patches) {
      s = { ...baseState(), ...patch }
      const auth = makeAuthority()
      expect(auth.mint(frame)).toBe(false)
      expect(auth.hasPending(frame)).toBe(false)
    }
  })

  it('mint refuses a subframe or a stale url', () => {
    const auth = makeAuthority()
    expect(auth.mint({ ...frame, isTopFrame: false })).toBe(false)
    expect(auth.mint({ ...frame, url: 'app://metis/other.html' })).toBe(false)
    s = { ...s, currentUrl: '' }
    expect(auth.mint(frame)).toBe(false)
    s = { ...baseState(), mainWebContentsId: null }
    expect(auth.mint(frame)).toBe(false)
    s = { ...baseState(), mainFrameId: '12:4' }
    expect(auth.mint(frame)).toBe(false)
    s = baseState()
    expect(auth.mint(frame)).toBe(true)
  })
})

describe('CommandMicActivationAuthority hardware activation (voice turn)', () => {
  let s: CommandMicActivationState
  let t: number
  beforeEach(() => {
    s = baseState()
    t = 1_000
  })
  const make = (ttlMs?: number) => new CommandMicActivationAuthority({ state: () => s, now: () => t, ttlMs })

  it('mintFromHardware then a hardware consume succeeds exactly once', () => {
    const auth = make()
    expect(auth.mintFromHardware(frame)).toBe(true)
    expect(auth.hasPending(frame, 'hardware')).toBe(true)
    expect(auth.consume(frame, 'hardware')).toBe(true)
    expect(auth.consume(frame, 'hardware')).toBe(false)
  })

  it('a hardware grant is invisible to the click path and a click grant is invisible to the hardware path', () => {
    const auth = make()
    expect(auth.mintFromHardware(frame)).toBe(true)
    expect(auth.hasPending(frame)).toBe(false)
    expect(auth.consume(frame)).toBe(false)
    expect(auth.consume(frame, 'hardware')).toBe(true)

    expect(auth.mint(frame)).toBe(true)
    expect(auth.hasPending(frame, 'hardware')).toBe(false)
    expect(auth.consume(frame, 'hardware')).toBe(false)
    expect(auth.consume(frame)).toBe(true)
  })

  it('a second hardware mint for the same turn does not stack grants', () => {
    const auth = make()
    expect(auth.mintFromHardware(frame)).toBe(true)
    expect(auth.mintFromHardware(frame)).toBe(true)
    expect(auth.consume(frame, 'hardware')).toBe(true)
    expect(auth.consume(frame, 'hardware')).toBe(false)
  })

  it('refuses a hidden, signed-out or unavailable state, a subframe and a stale url', () => {
    for (const patch of [
      { isWindowVisible: false },
      { isAuthenticated: false },
      { isParakeetSelected: false }
    ] as Array<Partial<CommandMicActivationState>>) {
      s = { ...baseState(), ...patch }
      const auth = make()
      expect(auth.mintFromHardware(frame)).toBe(false)
      expect(auth.hasPending(frame, 'hardware')).toBe(false)
    }
    s = baseState()
    const auth = make()
    expect(auth.mintFromHardware({ ...frame, isTopFrame: false })).toBe(false)
    expect(auth.mintFromHardware({ ...frame, url: 'app://metis/other.html' })).toBe(false)
  })

  it('expires after the ttl and dies with a new auth generation, like a click grant', () => {
    const auth = make(100)
    expect(auth.mintFromHardware(frame)).toBe(true)
    t += 100
    expect(auth.consume(frame, 'hardware')).toBe(false)

    t = 1_000
    const rotated = make()
    expect(rotated.mintFromHardware(frame)).toBe(true)
    s = { ...s, context: { authSessionGeneration: 6, contextRevision: 11 } }
    expect(rotated.consume(frame, 'hardware')).toBe(false)
  })

  it('revokeHardware drops only hardware grants; revokeAll drops both', () => {
    const auth = make()
    expect(auth.mint(frame)).toBe(true)
    expect(auth.mintFromHardware(frame)).toBe(true)
    auth.revokeHardware()
    expect(auth.hasPending(frame, 'hardware')).toBe(false)
    expect(auth.hasPending(frame)).toBe(true)
    expect(auth.mintFromHardware(frame)).toBe(true)
    auth.revokeAll()
    expect(auth.hasPending(frame)).toBe(false)
    expect(auth.hasPending(frame, 'hardware')).toBe(false)
  })
})

describe('commandMicOwner', () => {
  const context = { authSessionGeneration: 5, contextRevision: 11 }

  it('commandMicOwner derives a frozen top-frame owner and refuses bad frames', () => {
    expect(commandMicOwner({ ...frame, isTopFrame: false }, context)).toBeNull()
    expect(commandMicOwner({ ...frame, webContentsId: 0 }, context)).toBeNull()
    expect(commandMicOwner({ ...frame, frameId: '' }, context)).toBeNull()
    expect(commandMicOwner({ ...frame, frameId: 'x'.repeat(257) }, context)).toBeNull()

    const owner = commandMicOwner(frame, context)
    expect(owner).not.toBeNull()
    expect(Object.isFrozen(owner)).toBe(true)
    expect(owner?.isTopFrame).toBe(true)
    expect(owner?.webContentsId).toBe(7)
    expect(owner?.frameId).toBe('12:3')
    expect(owner?.authSessionGeneration).toBe(5)
    expect(owner?.contextRevision).toBe(11)
  })
})
