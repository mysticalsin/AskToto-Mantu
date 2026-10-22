import { describe, expect, it, vi } from 'vitest'
import { abortAllAskStreams, boundedAnswerAskId } from './ask-stream-registry'

describe('abortAllAskStreams', () => {
  it('aborts every registered stream and empties the registry', () => {
    const a = vi.fn()
    const b = vi.fn()
    const streams = new Map([
      ['ask-a', { abort: a }],
      ['ask-b', { abort: b }]
    ])

    abortAllAskStreams(streams)

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(streams.size).toBe(0)
  })

  it('one stream that throws on abort never keeps the others running or the registry populated', () => {
    const survivor = vi.fn()
    const streams = new Map([
      [
        'broken',
        {
          abort: () => {
            throw new Error('synthetic abort failure')
          }
        }
      ],
      ['ok', { abort: survivor }]
    ])

    expect(() => abortAllAskStreams(streams)).not.toThrow()

    expect(survivor).toHaveBeenCalledTimes(1)
    expect(streams.size).toBe(0)
  })

  it('is a no-op on an empty registry', () => {
    const streams = new Map<string, { abort: () => void }>()
    expect(() => abortAllAskStreams(streams)).not.toThrow()
    expect(streams.size).toBe(0)
  })
})

describe('boundedAnswerAskId', () => {
  it('accepts a non-empty string of at most 128 characters', () => {
    expect(boundedAnswerAskId('ask-123')).toBe('ask-123')
    expect(boundedAnswerAskId('x'.repeat(128))).toBe('x'.repeat(128))
  })

  it('rejects anything else so the rating falls back to the last ask instead of recording junk', () => {
    expect(boundedAnswerAskId('x'.repeat(129))).toBeUndefined()
    expect(boundedAnswerAskId('')).toBeUndefined()
    expect(boundedAnswerAskId('   ')).toBeUndefined()
    expect(boundedAnswerAskId(42)).toBeUndefined()
    expect(boundedAnswerAskId({ id: 'ask' })).toBeUndefined()
    expect(boundedAnswerAskId(null)).toBeUndefined()
    expect(boundedAnswerAskId(undefined)).toBeUndefined()
  })
})
