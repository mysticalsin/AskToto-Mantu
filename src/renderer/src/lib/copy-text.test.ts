import { describe, expect, it, vi } from 'vitest'
import { copyText } from './copy-text'

describe('copyText (G55)', () => {
  it('writes paragraphs and lists byte for byte', async () => {
    const text = 'First paragraph.\n\nSecond one.\n\n- a\n  - nested\n- b\n\n1. x\n2. y\n\n```ts\nconst a = 1\n```\n'
    const writeText = vi.fn(async () => undefined)
    expect(await copyText(text, { writeText })).toBeNull()
    expect(writeText).toHaveBeenCalledWith(text)
  })

  it('reports a rejected write instead of claiming success', async () => {
    const msg = await copyText('x', {
      writeText: async () => {
        throw new Error('denied')
      }
    })
    expect(msg).toBe('Copy failed: denied')
  })
})
