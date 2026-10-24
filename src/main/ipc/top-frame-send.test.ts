import { describe, expect, it, vi } from 'vitest'
import { sendToTopFrame } from './top-frame-send'

const target = { processId: 1, routingId: 2 }

describe('sendToTopFrame', () => {
  it('sends to a live top frame', () => {
    const send = vi.fn()
    sendToTopFrame(() => ({ parent: null, send }), target, 'ch', { a: 1 })
    expect(send).toHaveBeenCalledWith('ch', { a: 1 })
  })

  it('sends nothing to a missing, destroyed or child frame', () => {
    const send = vi.fn()
    sendToTopFrame(() => null, target, 'ch', 1)
    sendToTopFrame(() => ({ parent: null, isDestroyed: () => true, send }), target, 'ch', 1)
    sendToTopFrame(() => ({ parent: {}, send }), target, 'ch', 1)
    expect(send).not.toHaveBeenCalled()
  })

  it('swallows a throwing lookup or send', () => {
    expect(() =>
      sendToTopFrame(
        () => {
          throw new Error('gone')
        },
        target,
        'ch',
        1
      )
    ).not.toThrow()
    expect(() =>
      sendToTopFrame(
        () => ({
          parent: null,
          send: () => {
            throw new Error('detached')
          }
        }),
        target,
        'ch',
        1
      )
    ).not.toThrow()
  })
})
