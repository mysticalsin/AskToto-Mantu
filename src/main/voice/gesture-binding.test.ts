import { describe, expect, it } from 'vitest'
import { createGestureBindings } from './gesture-binding'

const OWNER = { webContentsId: 7, revision: 3 }
const MAIL = { windowId: 'com.apple.mail', pid: 100, title: 'Inbox' }

function make(frontmost: () => typeof MAIL | null = () => MAIL) {
  let clock = 1_000
  let id = 0
  const bindings = createGestureBindings({
    frontmost,
    now: () => clock,
    newId: () => `gb-${(id += 1)}`,
    ttlMs: 60_000
  })
  return { bindings, advance: (ms: number) => (clock += ms) }
}

describe('gesture bindings (G34)', () => {
  it('captures the front app main observed at the instant the gesture starts', () => {
    let front: typeof MAIL | null = MAIL
    const { bindings } = make(() => front)
    const binding = bindings.begin(OWNER, 'command-1')
    front = { windowId: 'com.apple.notes', pid: 200, title: '' }
    expect(binding).toMatchObject({ owner: OWNER, sessionId: 'command-1', target: MAIL, capturedAtMs: 1_000 })
    expect(bindings.current(7)?.target).toEqual(MAIL)
  })

  it('records no target when the foreground cannot be observed', () => {
    const { bindings } = make(() => null)
    expect(bindings.begin(OWNER, 'command-1').target).toBeNull()
  })

  it('a new gesture replaces the old binding for that owner and cannot be read by another owner', () => {
    const { bindings } = make()
    const first = bindings.begin(OWNER, 'command-1')
    const second = bindings.begin(OWNER, 'command-2')
    expect(second.bindingId).not.toBe(first.bindingId)
    expect(bindings.current(7)?.bindingId).toBe(second.bindingId)
    expect(bindings.current(8)).toBeNull()
  })

  it('expires a binding so a stale gesture cannot bind a later task', () => {
    const { bindings, advance } = make()
    bindings.begin(OWNER, 'command-1')
    advance(60_001)
    expect(bindings.current(7)).toBeNull()
  })

  it('clear drops every binding (Stop, sign-out, lock)', () => {
    const { bindings } = make()
    bindings.begin(OWNER, 'command-1')
    bindings.clear()
    expect(bindings.current(7)).toBeNull()
  })

  it('returns frozen bindings', () => {
    const { bindings } = make()
    expect(Object.isFrozen(bindings.begin(OWNER, 'command-1'))).toBe(true)
  })
})
