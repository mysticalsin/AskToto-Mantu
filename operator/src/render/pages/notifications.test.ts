import { describe, expect, it } from 'vitest'
import { fixtureDashboard } from '../fixture'
import { renderNotifications } from './notifications'

const CTX = { now: 1_725_000_000_000, theme: 'light' as const }

describe('renderNotifications (QA fixture)', () => {
  it('renders the notices, CRM telemetry, and skills sections, no inline style=', async () => {
    const data = await fixtureDashboard()
    const html = renderNotifications(data, CTX)
    expect(html).toContain('data-crm-notices')
    expect(html).toContain('data-skill-notices')
    expect(html).toContain('>Notifications<')
    expect(html).not.toContain('style="')
  })
})
