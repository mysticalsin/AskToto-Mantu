import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AccountChoiceCard as Card } from '@shared/connector-account-choice'
import { AccountChoiceCard, accountOptionLabel, accountOptionNote } from './AccountChoiceCard'

const REF = (c: string) => `acct_${c.repeat(43)}` as never
const card: Card = {
  choiceId: 'a'.repeat(32),
  nonce: 'b'.repeat(64),
  argsHash: 'c'.repeat(64),
  expiresAt: 10,
  title: 'Which account for this draft?',
  detail: 'You have more than one Outlook account. Choose where to save the draft. It will not be sent.',
  options: [
    { accountRef: REF('A'), label: 'Work', maskedHint: 'w***@example.test', health: 'healthy', selectable: true },
    { accountRef: REF('B'), label: 'Personal', health: 'connecting', selectable: true },
    { accountRef: REF('C'), label: 'Old', health: 'needs_reauth', selectable: false }
  ]
}
const html = renderToStaticMarkup(<AccountChoiceCard card={card} onChoose={vi.fn()} onCancel={vi.fn()} />)

describe('AccountChoiceCard (G62)', () => {
  it('is a labelled modal dialog with the title and the plain-language detail', () => {
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('Which account for this draft?')
    expect(html).toContain('It will not be sent.')
  })

  it('lists each account by label and masked hint only, never an opaque ref or full address', () => {
    expect(html).toContain('aria-label="Use Work, w***@example.test"')
    expect(html).toContain('aria-label="Use Personal"')
    expect(html).not.toContain('acct_')
    expect(html).not.toMatch(/[^*]@example\.test/)
  })

  it('disables an account that needs attention and explains why, without a default action', () => {
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Use Old"/)
    expect(html).toContain('Needs attention. Reconnect it in Settings.')
    expect(html).toContain('Verified when you use it')
    expect(html).toContain('>Cancel</button>')
    expect(html).not.toContain('autofocus')
  })

  it('words health honestly', () => {
    expect(accountOptionNote('healthy', true)).toBeNull()
    expect(accountOptionNote('degraded', false)).toBe('Having trouble connecting right now')
    expect(accountOptionNote('disconnected', false)).toBe('Not available')
    expect(accountOptionLabel(card.options[1])).toBe('Use Personal')
  })
})
