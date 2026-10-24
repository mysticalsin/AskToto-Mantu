import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectorConfirmCard as Card } from '@shared/connector-confirm'
import { ConnectorConfirmCard, effectClassNote } from './ConnectorConfirmCard'

const card: Card = {
  proposalId: 'a'.repeat(32),
  nonce: 'b'.repeat(64),
  argsHash: 'c'.repeat(64),
  summary: 'Create a mail draft (never sent)',
  connectorLabel: 'Outlook',
  accountLabel: 'Work',
  maskedHint: 'w***@example.test',
  effectClass: 'reversible_write',
  subjectPreview: 'Quarterly numbers',
  recipients: [{ address: 'ana@example.test', source: 'calendar-attendee' }],
  expiresAt: 10
}
const html = renderToStaticMarkup(<ConnectorConfirmCard card={card} onConfirm={vi.fn()} onCancel={vi.fn()} />)

describe('ConnectorConfirmCard (G64)', () => {
  it('is a labelled modal dialog that names the connector, account and effect class', () => {
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('data-effect-class="reversible_write"')
    expect(html).toContain('Outlook, Work')
    expect(html).toContain('This can be undone.')
  })

  it('shows the verified recipients and the subject preview, never an opaque id', () => {
    expect(html).toContain('ana@example.test')
    expect(html).toContain('Quarterly numbers')
    expect(html).not.toContain('acct_')
  })

  it('confirm is disabled during the 300 ms guard and cancel is always enabled', () => {
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Confirm<\/button>/)
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Cancel<\/button>/)
  })

  it('says plainly when an effect cannot be undone or sends a message', () => {
    expect(effectClassNote('irreversible_write')).toBe('This cannot be undone.')
    expect(effectClassNote('send')).toMatch(/sends a message/)
  })
})
