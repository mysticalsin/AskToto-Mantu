import { describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest } from '@shared/desktop-actions'
import {
  createActionGrantService,
  grantRevokeReasonForHardStop,
  grantRevokeReasonForLifecycle,
  NOT_METERED,
  type OsPermissionSeam,
  type PurchaseSeam
} from './grant-service'
import { GRANT_REFUSAL_COPY } from './grant-copy'

const NOTE: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'Synthetic private title' } }
const OPEN_X: DesktopActionRequest = { id: 'desktop.open_x', args: {} }
const SEARCH: DesktopActionRequest = { id: 'desktop.google_search', args: { q: 'synthetic query' } }
const OWNER = { webContentsId: 7, authGeneration: 1 }

const verdict = (status: 'granted' | 'not-required') => ({ check: async () => ({ status }) }) satisfies OsPermissionSeam

function make(
  options: {
    purchase?: PurchaseSeam
    /** `null` binds no permission seam at all. Omitted binds one that reports every permission granted. */
    permission?: OsPermissionSeam | null
    context?: { conversationId?: string; taskLineageId?: string }
    platform?: string
  } = {}
) {
  const audit = vi.fn()
  const context = { conversationId: 'conv-1', taskLineageId: 'task-A', ...options.context }
  const service = createActionGrantService({
    platform: options.platform ?? 'darwin',
    audit,
    context: () => context,
    purchase: options.purchase,
    permission: options.permission === null ? undefined : (options.permission ?? verdict('granted'))
  })
  return { service, audit }
}

describe('issuing a grant from an approval', () => {
  it('scopes to the task or conversation named by main, never by the caller', () => {
    const { service } = make({ context: { taskLineageId: 'task-Z' } })
    expect(service.issueFromApproval(OWNER, NOTE, 'task').ok).toBe(true)
    expect(service.list()).toHaveLength(1)
  })

  it('the default scope is one action: it binds the exact request and is not stored as a standing grant', async () => {
    const { service } = make()
    expect(service.issueFromApproval(OWNER, NOTE, 'action').ok).toBe(true)
    const same = await service.decide(OWNER, NOTE, 'push-to-talk')
    expect(same.outcome).toBe('run')
    const different = await service.decide(
      OWNER,
      { id: 'desktop.create_note', args: { title: 'Else' } },
      'push-to-talk'
    )
    expect(different.outcome).toBe('confirm')
  })

  it('refuses a standing grant for an action class that always asks', () => {
    const { service } = make()
    expect(service.issueFromApproval(OWNER, SEARCH, 'task')).toEqual({ ok: false, reason: 'not_grantable' })
    expect(service.issueFromApproval(OWNER, { id: 'desktop.photo_booth_capture', args: {} }, 'conversation')).toEqual({
      ok: false,
      reason: 'not_grantable'
    })
  })

  it('on a platform that cannot run the action there is nothing to grant', () => {
    const { service } = make({ platform: 'linux' })
    expect(service.issueFromApproval(OWNER, NOTE, 'task')).toEqual({ ok: false, reason: 'not_grantable' })
  })
})

describe('decide: allowance, purchase and permission are three separate decisions', () => {
  it('without a grant the answer is the confirm card, with allowance copy', async () => {
    const { service } = make()
    const d = await service.decide(OWNER, NOTE, 'push-to-talk')
    expect(d).toEqual({
      outcome: 'confirm',
      refusal: { decision: 'allowance', reason: 'no_grant', copy: GRANT_REFUSAL_COPY.no_grant }
    })
  })

  it('a task grant skips the card for the same action in the same task', async () => {
    const { service, audit } = make({ permission: verdict('granted') })
    service.issueFromApproval(OWNER, NOTE, 'task')
    const d = await service.decide(OWNER, { id: 'desktop.create_note', args: { title: 'Second note' } }, 'push-to-talk')
    expect(d.outcome).toBe('run')
    expect(audit).toHaveBeenCalledWith(
      'grant.decision',
      expect.objectContaining({ decision: 'allowance', outcome: 'allowed', actionId: 'desktop.create_note' })
    )
  })

  it('the same grant never covers another action, and never covers a different task', async () => {
    const { service } = make()
    service.issueFromApproval(OWNER, NOTE, 'task')
    expect((await service.decide(OWNER, OPEN_X, 'push-to-talk')).outcome).toBe('confirm')
    const other = make({ context: { taskLineageId: 'task-B' } })
    expect((await other.service.decide(OWNER, NOTE, 'push-to-talk')).outcome).toBe('confirm')
  })

  it('a wake word never runs an action, grant or not', async () => {
    const { service } = make()
    service.issueFromApproval(OWNER, NOTE, 'conversation')
    const d = await service.decide(OWNER, NOTE, 'wake')
    expect(d).toMatchObject({ outcome: 'confirm', refusal: { decision: 'allowance', reason: 'source_not_trusted' } })
  })

  it('the panel click and the held chord are trusted sources', async () => {
    const { service } = make()
    service.issueFromApproval(OWNER, NOTE, 'conversation')
    expect((await service.decide(OWNER, NOTE, 'panel')).outcome).toBe('run')
    expect((await service.decide(OWNER, NOTE, 'push-to-talk')).outcome).toBe('run')
  })

  it('a send, type or delete class never reaches the grant lookup: it always confirms', async () => {
    const { service } = make()
    service.issueFromApproval(OWNER, NOTE, 'conversation')
    for (const cls of ['send', 'type', 'delete'] as const) {
      const d = await service.decideForClass(OWNER, NOTE, cls, 'push-to-talk')
      expect(d).toMatchObject({ outcome: 'confirm', refusal: { decision: 'allowance', reason: 'not_grantable' } })
    }
  })

  it('an expired or revoked grant brings the card back with its own copy', async () => {
    let t = 0
    const service = createActionGrantService({
      platform: 'darwin',
      now: () => t,
      context: () => ({ taskLineageId: 'task-A' })
    })
    service.issueFromApproval(OWNER, NOTE, 'task')
    t += 31 * 60_000
    expect(await service.decide(OWNER, NOTE, 'push-to-talk')).toMatchObject({
      outcome: 'confirm',
      refusal: { reason: 'grant_expired', copy: GRANT_REFUSAL_COPY.grant_expired }
    })
  })

  it('purchase: an exhausted allowance refuses with quota copy and runs nothing', async () => {
    const { service, audit } = make({
      purchase: { check: async () => 'exhausted' as const },
      permission: verdict('granted')
    })
    service.issueFromApproval(OWNER, NOTE, 'task')
    const d = await service.decide(OWNER, NOTE, 'push-to-talk')
    expect(d).toEqual({
      outcome: 'refuse',
      refusal: { decision: 'purchase', reason: 'quota_exhausted', copy: GRANT_REFUSAL_COPY.quota_exhausted }
    })
    expect(audit).toHaveBeenCalledWith(
      'grant.decision',
      expect.objectContaining({ decision: 'purchase', outcome: 'refused' })
    )
  })

  it('purchase: a meter that cannot be read, or throws, fails closed', async () => {
    for (const purchase of [
      { check: async () => 'unavailable' as const },
      {
        check: async (): Promise<'available'> => {
          throw new Error('meter down')
        }
      }
    ]) {
      const { service } = make({ purchase, permission: verdict('granted') })
      service.issueFromApproval(OWNER, NOTE, 'task')
      expect(await service.decide(OWNER, NOTE, 'push-to-talk')).toMatchObject({
        outcome: 'refuse',
        refusal: { decision: 'purchase', reason: 'quota_unavailable' }
      })
    }
  })

  it('purchase: no meter bound is reported honestly as not metered and does not block', async () => {
    expect(await NOT_METERED.check({ actionId: 'desktop.create_note' })).toBe('not_metered')
    const { service, audit } = make({ permission: verdict('granted') })
    service.issueFromApproval(OWNER, NOTE, 'task')
    expect((await service.decide(OWNER, NOTE, 'push-to-talk')).outcome).toBe('run')
    expect(audit).toHaveBeenCalledWith(
      'grant.decision',
      expect.objectContaining({ decision: 'purchase', outcome: 'not_metered' })
    )
  })

  it('a purchase never mints a grant: an available quota with no grant still asks', async () => {
    const { service } = make({ purchase: { check: async () => 'available' as const } })
    expect((await service.decide(OWNER, NOTE, 'push-to-talk')).outcome).toBe('confirm')
    expect(service.list()).toEqual([])
  })

  it('permission: a denied OS permission refuses with permission copy naming where to turn it on', async () => {
    const permission: OsPermissionSeam = {
      check: async () => ({ status: 'denied', permission: 'automation', target: 'Notes' })
    }
    const { service, audit } = make({ permission })
    service.issueFromApproval(OWNER, NOTE, 'task')
    const d = await service.decide(OWNER, NOTE, 'push-to-talk')
    expect(d).toMatchObject({ outcome: 'refuse', refusal: { decision: 'permission', reason: 'permission_denied' } })
    if (d.outcome !== 'refuse') return
    expect(d.refusal.copy).toContain('Notes')
    expect(audit).toHaveBeenCalledWith(
      'grant.decision',
      expect.objectContaining({ decision: 'permission', outcome: 'refused', permission: 'automation' })
    )
  })

  it('permission: an unreadable permission falls back to the card instead of running silently', async () => {
    const permission: OsPermissionSeam = { check: async () => ({ status: 'unknown', permission: 'automation' }) }
    const { service } = make({ permission })
    service.issueFromApproval(OWNER, NOTE, 'task')
    expect(await service.decide(OWNER, NOTE, 'push-to-talk')).toMatchObject({
      outcome: 'confirm',
      refusal: { decision: 'permission', reason: 'permission_unverified' }
    })
  })

  it('permission: with no probe bound at all a grant cannot skip the card', async () => {
    const { service } = make({ permission: null })
    service.issueFromApproval(OWNER, NOTE, 'task')
    expect(await service.decide(OWNER, NOTE, 'push-to-talk')).toMatchObject({
      outcome: 'confirm',
      refusal: { decision: 'permission', reason: 'permission_unverified' }
    })
  })

  it('permission: a seam that throws is unknown, never granted', async () => {
    const permission: OsPermissionSeam = {
      check: async () => {
        throw new Error('helper crashed')
      }
    }
    const { service } = make({ permission })
    service.issueFromApproval(OWNER, NOTE, 'task')
    expect((await service.decide(OWNER, NOTE, 'push-to-talk')).outcome).toBe('confirm')
  })

  it('the three refusal copies are distinct, calm, and carry no em dash', () => {
    const copies = Object.values(GRANT_REFUSAL_COPY)
    expect(new Set(copies).size).toBe(copies.length)
    for (const copy of copies) expect(copy).not.toContain('—')
    expect(GRANT_REFUSAL_COPY.quota_exhausted).toMatch(/plan/i)
    expect(GRANT_REFUSAL_COPY.permission_denied).toMatch(/System Settings|Privacy/i)
    expect(GRANT_REFUSAL_COPY.no_grant).toMatch(/approve/i)
  })

  it('audit never carries request content, titles, queries or hashes', async () => {
    const { service, audit } = make({ permission: verdict('granted') })
    service.issueFromApproval(OWNER, NOTE, 'task')
    await service.decide(OWNER, NOTE, 'push-to-talk')
    const text = JSON.stringify(audit.mock.calls)
    expect(text).not.toContain('Synthetic private title')
    expect(text).not.toMatch(/[a-f0-9]{64}/)
  })
})

describe('effects check for an approved card (purchase and permission, no grant needed)', () => {
  it('passes with no seams bound', async () => {
    const { service } = make({ permission: null })
    expect(await service.checkEffects(NOTE)).toBeNull()
  })

  it('refuses on exhausted quota or denied OS permission, each with its own decision', async () => {
    const a = make({ purchase: { check: async () => 'exhausted' as const } })
    expect(await a.service.checkEffects(NOTE)).toMatchObject({ decision: 'purchase', reason: 'quota_exhausted' })
    const b = make({
      permission: { check: async () => ({ status: 'denied', permission: 'accessibility', target: 'Accessibility' }) }
    })
    expect(await b.service.checkEffects(NOTE)).toMatchObject({ decision: 'permission', reason: 'permission_denied' })
  })

  it('an unreadable permission does not block an explicit approval: the adapter does its own read-only check', async () => {
    const { service } = make({ permission: { check: async () => ({ status: 'unknown', permission: 'automation' }) } })
    expect(await service.checkEffects(NOTE)).toBeNull()
  })
})

describe('revocation wiring', () => {
  it('maps the lifecycle events that end a grant, and ignores routine blur and hide', () => {
    expect(grantRevokeReasonForLifecycle('auth_session_cleared')).toBe('sign_out')
    expect(grantRevokeReasonForLifecycle('window_replaced')).toBe('owner_switch')
    expect(grantRevokeReasonForLifecycle('window_closed')).toBe('owner_switch')
    expect(grantRevokeReasonForLifecycle('renderer_replaced')).toBe('owner_switch')
    expect(grantRevokeReasonForLifecycle('system_suspend')).toBe('lock_or_suspend')
    expect(grantRevokeReasonForLifecycle('screen_locked')).toBe('lock_or_suspend')
    for (const routine of ['window_blurred', 'window_hidden', 'expired', 'runtime_proposal_replaced', 'cancelled']) {
      expect(grantRevokeReasonForLifecycle(routine)).toBeNull()
    }
  })

  it('maps the input-session hard stops: Stop, sign-out and owner replacement end grants; a routine turn end does not', () => {
    expect(grantRevokeReasonForHardStop('user-stop')).toBe('stop')
    expect(grantRevokeReasonForHardStop('shutdown')).toBe('stop')
    expect(grantRevokeReasonForHardStop('sign-out')).toBe('sign_out')
    expect(grantRevokeReasonForHardStop('auth-revoked')).toBe('sign_out')
    expect(grantRevokeReasonForHardStop('owner-replaced')).toBe('owner_switch')
    expect(grantRevokeReasonForHardStop('renderer-reset')).toBe('owner_switch')
    expect(grantRevokeReasonForHardStop('system-suspend')).toBe('lock_or_suspend')
    expect(grantRevokeReasonForHardStop('screen-locked')).toBe('lock_or_suspend')
    for (const routine of ['cancelled', 'window-hidden', 'device-change', 'arbitration-preempted']) {
      expect(grantRevokeReasonForHardStop(routine)).toBeNull()
    }
  })

  it('the service revokes on a mapped event and leaves grants alone on an unmapped one', () => {
    const { service } = make()
    service.issueFromApproval(OWNER, NOTE, 'conversation')
    service.onLifecycleEvent('window_blurred')
    expect(service.list()).toHaveLength(1)
    service.onLifecycleEvent('auth_session_cleared')
    expect(service.list()).toEqual([])
    service.issueFromApproval(OWNER, NOTE, 'conversation')
    service.onHardStop('user-stop')
    expect(service.list()).toEqual([])
  })

  it('ending a task or a conversation revokes its grants', () => {
    const { service } = make()
    service.issueFromApproval(OWNER, NOTE, 'task')
    service.issueFromApproval(OWNER, NOTE, 'conversation')
    expect(service.endTask('task-A')).toBe(1)
    expect(service.endConversation('conv-1')).toBe(1)
    expect(service.list()).toEqual([])
  })
})
