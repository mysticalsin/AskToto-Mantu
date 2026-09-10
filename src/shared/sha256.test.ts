import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from './sha256'

describe('shared synchronous SHA-256', () => {
  it.each([
    '',
    'Métis',
    '株式会社アクメ',
    'speaker 🎙️',
    'multi-block '.repeat(40),
    'a'.repeat(20_000)
  ])('matches Node crypto for a UTF-8 fixture', (text) => {
    expect(sha256Hex(text)).toBe(createHash('sha256').update(text).digest('hex'))
  })
})
