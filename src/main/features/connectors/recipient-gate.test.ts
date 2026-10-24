import { describe, expect, it } from 'vitest'
import { noTrustedRecipients, verifyRecipients } from './recipient-gate'

const TRUSTED = [{ address: 'Ana@Example.test', source: 'calendar-attendee' }]

describe('recipient gate', () => {
  it('verifies vacuously when the arguments name nobody', () => {
    expect(verifyRecipients({ subject: 's' }, [])).toEqual({ ok: true, recipients: [] })
  })
  it('accepts only addresses in the trusted set, case-insensitively', () => {
    expect(verifyRecipients({ to: ['ana@example.test'] }, TRUSTED)).toEqual({ ok: true, recipients: TRUSTED })
    expect(verifyRecipients({ to: ['ana@example.test', 'eve@example.test'] }, TRUSTED)).toEqual({
      ok: false,
      recipientCount: 2
    })
  })
  it('fails closed with the production source that trusts nobody', async () => {
    const trusted = await noTrustedRecipients.addressesFor({ accountRef: 'x' as never })
    expect(verifyRecipients({ cc: 'ana@example.test' }, trusted).ok).toBe(false)
  })
})
