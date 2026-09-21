import { describe, expect, it } from 'vitest'
import { executeDesktopAction } from './desktop-adapters'

describe('desktop adapters fixed-demo request guard', () => {
  it('rejects a note title outside the fixed demo before selecting a platform adapter', async () => {
    const result = await executeDesktopAction(
      { id: 'desktop.create_note', args: { title: '"; do shell script "bad"' } },
      'other'
    )

    expect(result).toEqual({
      id: 'desktop.create_note',
      ok: false,
      outcome: 'unsupported',
      detail: 'Unsupported fixed-demo note title'
    })
  })

  it('rejects a search query outside the fixed demo before selecting a platform adapter', async () => {
    const result = await executeDesktopAction(
      { id: 'desktop.google_search', args: { q: 'https://attacker.invalid/?x=1' } },
      'other'
    )

    expect(result).toEqual({
      id: 'desktop.google_search',
      ok: false,
      outcome: 'unsupported',
      detail: 'Unsupported fixed-demo search query'
    })
  })
})
