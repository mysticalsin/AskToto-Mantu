import { describe, expect, it, vi } from 'vitest'
import { SESSION_CONTEXT_IPC } from '@shared/session-context-request'
import { readModuleSource } from '../../test-helpers/module-source'
import { createOutputsStalePush } from './push-outputs-stale'

const frame = (over: Record<string, unknown> = {}) => ({
  parent: null,
  isDestroyed: vi.fn(() => false),
  send: vi.fn<(channel: string, ...args: unknown[]) => void>(),
  ...over
})

describe('createOutputsStalePush', () => {
  it('sends the output ids to the one top frame that owns the meeting, on its own channel', () => {
    const target = frame()
    const frameFor = vi.fn(() => target)
    createOutputsStalePush(frameFor)({ processId: 12, routingId: 3 }, ['ask-1', 'ask-2'])
    expect(frameFor).toHaveBeenCalledExactlyOnceWith(12, 3)
    expect(target.send).toHaveBeenCalledExactlyOnceWith(SESSION_CONTEXT_IPC.outputsStale, { ids: ['ask-1', 'ask-2'] })
  })

  it('sends nothing to a missing, destroyed or child frame, and never throws into the registry', () => {
    const push = (target: unknown) =>
      createOutputsStalePush(() => target as never)({ processId: 1, routingId: 1 }, ['a'])
    const gone = frame({ isDestroyed: () => true })
    const child = frame({ parent: {} })
    expect(() => push(null)).not.toThrow()
    expect(() => push(gone)).not.toThrow()
    expect(() => push(child)).not.toThrow()
    expect(gone.send).not.toHaveBeenCalled()
    expect(child.send).not.toHaveBeenCalled()
    const broken = frame({
      send: () => {
        throw new Error('detached')
      }
    })
    expect(() => push(broken)).not.toThrow()
    expect(() =>
      createOutputsStalePush(() => {
        throw new Error('no such frame')
      })({ processId: 1, routingId: 1 }, ['a'])
    ).not.toThrow()
  })

  it('refuses an empty or oversized id list instead of sending a payload the renderer would drop', () => {
    const target = frame()
    const push = createOutputsStalePush(() => target)
    push({ processId: 1, routingId: 1 }, [])
    expect(target.send).not.toHaveBeenCalled()
  })
})

describe('the main wiring plugs the push into the meeting contexts', () => {
  it('hands bindMeetingContexts a sender built over the real webFrameMain lookup', () => {
    const source = readModuleSource(__dirname, '../lifecycle/owner-session-wiring').text
    expect(source).toMatch(
      /sendOutputsStale:\s*createOutputsStalePush\(\(processId, routingId\) =>\s*webFrameMain\.fromId\(processId, routingId\)\)/
    )
  })
})
