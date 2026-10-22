import { describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest } from '@shared/desktop-actions'
import { actionArgsHash } from '../../action-guard'
import { ActionGrantStore } from './grant-store'
import { GRANT_SCOPE_KINDS, GRANTABLE_CLASSES } from './grant-model'

const NOTE: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'Synthetic private title' } }
const OTHER_NOTE: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'Another synthetic title' } }
const OPEN_X: DesktopActionRequest = { id: 'desktop.open_x', args: {} }
const OWNER = { webContentsId: 7, authGeneration: 3 }
const CTX = { taskLineageId: 'task-A', conversationId: 'conv-1' }

function makeStore(now = { t: 1_000 }) {
  const audit = vi.fn()
  let n = 0
  const store = new ActionGrantStore({ now: () => now.t, newId: () => `g${++n}`, audit })
  return { store, audit, now }
}

const issueInput = (request: DesktopActionRequest, scope: (typeof GRANT_SCOPE_KINDS)[number], actionClass = 'create') =>
  ({
    scope,
    request,
    argsHash: actionArgsHash(request),
    actionClass: actionClass as never,
    owner: OWNER,
    context: CTX
  }) as const
const findInput = (request: DesktopActionRequest, actionClass = 'create', context: object = CTX, owner = OWNER) =>
  ({ request, argsHash: actionArgsHash(request), actionClass: actionClass as never, owner, context }) as const

describe('grant model', () => {
  it('knows three scopes and only reversible and create classes are grantable', () => {
    expect([...GRANT_SCOPE_KINDS]).toEqual(['action', 'task', 'conversation'])
    expect([...GRANTABLE_CLASSES]).toEqual(['reversible', 'create'])
  })
})

describe('ActionGrantStore: issuing', () => {
  it.each(['create', 'reversible'])('issues a task grant for a %s action', (cls) => {
    const { store } = makeStore()
    const issued = store.issue(issueInput(NOTE, 'task', cls))
    expect(issued.ok).toBe(true)
  })

  it.each(['send', 'type', 'delete', 'read'])('never issues a grant for a %s action in any scope', (cls) => {
    const { store, audit } = makeStore()
    for (const scope of GRANT_SCOPE_KINDS) {
      expect(store.issue(issueInput(NOTE, scope, cls))).toEqual({ ok: false, reason: 'not_grantable' })
    }
    expect(store.list()).toEqual([])
    expect(audit).toHaveBeenCalledWith(
      'grant.decision',
      expect.objectContaining({ decision: 'allowance', reason: 'not_grantable' })
    )
  })

  it('refuses a class the platform cannot run (null) and the camera shutter action', () => {
    const { store } = makeStore()
    expect(store.issue({ ...issueInput(NOTE, 'task'), actionClass: null })).toEqual({
      ok: false,
      reason: 'not_grantable'
    })
    const shutter: DesktopActionRequest = { id: 'desktop.photo_booth_capture', args: {} }
    expect(store.issue(issueInput(shutter, 'conversation'))).toEqual({ ok: false, reason: 'not_grantable' })
  })

  it('needs the main-owned scope id: no task lineage means no task grant, no conversation means no conversation grant', () => {
    const { store } = makeStore()
    expect(store.issue({ ...issueInput(NOTE, 'task'), context: {} })).toEqual({
      ok: false,
      reason: 'scope_unavailable'
    })
    expect(store.issue({ ...issueInput(NOTE, 'conversation'), context: { taskLineageId: 'task-A' } })).toEqual({
      ok: false,
      reason: 'scope_unavailable'
    })
    expect(store.issue({ ...issueInput(NOTE, 'task'), context: { taskLineageId: '' } })).toEqual({
      ok: false,
      reason: 'scope_unavailable'
    })
    // An action grant needs no scope id: it binds the exact request.
    expect(store.issue({ ...issueInput(NOTE, 'action'), context: {} }).ok).toBe(true)
  })

  it('bounds the number of live grants', () => {
    const { store } = makeStore()
    for (let i = 0; i < 32; i += 1) {
      expect(store.issue({ ...issueInput(NOTE, 'task'), context: { taskLineageId: `t${i}` } }).ok).toBe(true)
    }
    expect(store.issue({ ...issueInput(NOTE, 'task'), context: { taskLineageId: 'overflow' } })).toEqual({
      ok: false,
      reason: 'limit'
    })
  })

  it('re-approving the same scope refreshes one grant instead of stacking', () => {
    const { store, now } = makeStore()
    store.issue(issueInput(NOTE, 'task'))
    now.t += 1_000
    store.issue(issueInput(OTHER_NOTE, 'task'))
    expect(store.list()).toHaveLength(1)
  })

  it('audits issue as metadata only: no argsHash, no title', () => {
    const { store, audit } = makeStore()
    store.issue(issueInput(NOTE, 'task'))
    const [event, metadata] = audit.mock.calls.find(([name]) => name === 'grant.issued')!
    expect(event).toBe('grant.issued')
    expect(metadata).toEqual({ scope: 'task', actionId: 'desktop.create_note', class: 'create' })
    expect(JSON.stringify(audit.mock.calls)).not.toContain('Synthetic private title')
    expect(JSON.stringify(audit.mock.calls)).not.toContain(actionArgsHash(NOTE))
  })
})

describe('ActionGrantStore: binding to the action id class and the scope', () => {
  it('a task grant for create_note covers another create_note in the same task, not a different action', () => {
    const { store } = makeStore()
    store.issue(issueInput(NOTE, 'task'))
    expect(store.find(findInput(OTHER_NOTE)).kind).toBe('match')
    // A grant for "create a note" never covers any other action id, whatever its class.
    expect(store.find(findInput(OPEN_X, 'reversible'))).toEqual({ kind: 'none', reason: 'no_grant' })
    expect(store.find(findInput({ id: 'desktop.google_search', args: { q: 'x' } }, 'read'))).toEqual({
      kind: 'none',
      reason: 'not_grantable'
    })
  })

  it('a grant does not cover the same action id when the platform now classifies it differently', () => {
    const { store } = makeStore()
    store.issue(issueInput(NOTE, 'task', 'create'))
    expect(store.find(findInput(NOTE, 'reversible'))).toEqual({ kind: 'none', reason: 'no_grant' })
  })

  it('never matches a send, type or delete class even if asked', () => {
    const { store } = makeStore()
    store.issue(issueInput(NOTE, 'conversation'))
    for (const cls of ['send', 'type', 'delete']) {
      expect(store.find(findInput(NOTE, cls))).toEqual({ kind: 'none', reason: 'not_grantable' })
    }
  })

  it('a task grant does not cross to another task lineage, and a conversation grant not to another conversation', () => {
    const { store } = makeStore()
    store.issue(issueInput(NOTE, 'task'))
    expect(store.find(findInput(NOTE, 'create', { taskLineageId: 'task-B', conversationId: 'conv-1' }))).toEqual({
      kind: 'none',
      reason: 'no_grant'
    })
    expect(store.find(findInput(NOTE, 'create', {}))).toEqual({ kind: 'none', reason: 'no_grant' })
    const second = makeStore()
    second.store.issue(issueInput(NOTE, 'conversation'))
    expect(second.store.find(findInput(NOTE, 'create', { conversationId: 'conv-2' }))).toEqual({
      kind: 'none',
      reason: 'no_grant'
    })
    expect(second.store.find(findInput(NOTE, 'create', { conversationId: 'conv-1' })).kind).toBe('match')
  })

  it('an action grant binds the exact args hash and is used up by one dispatch', () => {
    const { store } = makeStore()
    store.issue(issueInput(NOTE, 'action'))
    expect(store.find(findInput(OTHER_NOTE, 'create', {}))).toEqual({ kind: 'none', reason: 'no_grant' })
    const match = store.find(findInput(NOTE, 'create', {}))
    expect(match.kind).toBe('match')
    if (match.kind !== 'match') return
    expect(store.use(match.grant.grantId)).toBe(true)
    expect(store.use(match.grant.grantId)).toBe(false)
    expect(store.find(findInput(NOTE, 'create', {}))).toEqual({ kind: 'none', reason: 'no_grant' })
  })

  it('a task or conversation grant survives many uses', () => {
    const { store } = makeStore()
    store.issue(issueInput(NOTE, 'task'))
    const match = store.find(findInput(NOTE))
    if (match.kind !== 'match') throw new Error('expected match')
    expect(store.use(match.grant.grantId)).toBe(true)
    expect(store.use(match.grant.grantId)).toBe(true)
  })
})

describe('ActionGrantStore: expiry and revocation', () => {
  it('expires by clock: the match fails and says it expired, once', () => {
    const { store, now, audit } = makeStore()
    store.issue(issueInput(NOTE, 'task'))
    now.t += 31 * 60_000
    expect(store.find(findInput(NOTE))).toEqual({ kind: 'none', reason: 'grant_expired' })
    expect(store.list()).toEqual([])
    expect(audit).toHaveBeenCalledWith('grant.revoked', expect.objectContaining({ reason: 'expired' }))
    expect(store.find(findInput(NOTE))).toEqual({ kind: 'none', reason: 'no_grant' })
  })

  it('an expired grant cannot be used even if the id is still known', () => {
    const { store, now } = makeStore()
    const issued = store.issue(issueInput(NOTE, 'conversation'))
    if (!issued.ok) throw new Error('expected grant')
    now.t += 61 * 60_000
    expect(store.use(issued.grant.grantId)).toBe(false)
  })

  it('lifetimes are bounded per scope and injectable, never unbounded', () => {
    const now = { t: 0 }
    const store = new ActionGrantStore({ now: () => now.t, ttlMs: { task: 10 } })
    const task = store.issue(issueInput(NOTE, 'task'))
    const conv = store.issue(issueInput(NOTE, 'conversation'))
    if (!task.ok || !conv.ok) throw new Error('expected grants')
    expect(task.grant.expiresAt).toBe(10)
    expect(conv.grant.expiresAt).toBeGreaterThan(0)
    expect(conv.grant.expiresAt).toBeLessThanOrEqual(24 * 60 * 60_000)
  })

  it.each([
    ['stop', (s: ActionGrantStore) => s.revokeAll('stop')],
    ['sign_out', (s: ActionGrantStore) => s.revokeAll('sign_out')],
    ['owner_switch', (s: ActionGrantStore) => s.revokeAll('owner_switch')],
    ['lock_or_suspend', (s: ActionGrantStore) => s.revokeAll('lock_or_suspend')],
    ['task_end', (s: ActionGrantStore) => s.revokeTask('task-A')],
    ['conversation_end', (s: ActionGrantStore) => s.revokeConversation('conv-1')]
  ])('revocation by %s removes the grant and is audited with its reason', (reason, revoke) => {
    const { store, audit } = makeStore()
    store.issue(issueInput(NOTE, 'task'))
    store.issue({ ...issueInput(NOTE, 'conversation'), context: { conversationId: 'conv-1' } })
    revoke(store)
    expect(audit).toHaveBeenCalledWith('grant.revoked', expect.objectContaining({ reason }))
    if (reason === 'task_end') expect(store.list()).toHaveLength(1)
    else if (reason === 'conversation_end') expect(store.list()).toHaveLength(1)
    else expect(store.list()).toEqual([])
  })

  it('ending a task leaves a different task and the conversation grants alone', () => {
    const { store } = makeStore()
    store.issue(issueInput(NOTE, 'task'))
    store.issue({ ...issueInput(NOTE, 'task'), context: { taskLineageId: 'task-B' } })
    store.issue({ ...issueInput(NOTE, 'conversation'), context: { conversationId: 'conv-1' } })
    expect(store.revokeTask('task-A')).toBe(1)
    expect(
      store
        .list()
        .map((g) => g.scope)
        .sort()
    ).toEqual(['conversation', 'task'])
  })

  it('the user can revoke one grant by id', () => {
    const { store } = makeStore()
    const issued = store.issue(issueInput(NOTE, 'task'))
    if (!issued.ok) throw new Error('expected grant')
    expect(store.revokeGrant(issued.grant.grantId)).toBe(true)
    expect(store.revokeGrant(issued.grant.grantId)).toBe(false)
    expect(store.find(findInput(NOTE)).kind).toBe('none')
  })

  it('a lookup from a different renderer owner revokes the grant as an owner switch', () => {
    const { store, audit } = makeStore()
    store.issue(issueInput(NOTE, 'conversation'))
    expect(store.find(findInput(NOTE, 'create', CTX, { webContentsId: 99, authGeneration: 3 })).kind).toBe('none')
    expect(audit).toHaveBeenCalledWith('grant.revoked', expect.objectContaining({ reason: 'owner_switch' }))
    expect(store.list()).toEqual([])
  })

  it('a lookup under a newer sign-in generation revokes the grant as a sign-out', () => {
    const { store, audit } = makeStore()
    store.issue(issueInput(NOTE, 'conversation'))
    expect(store.find(findInput(NOTE, 'create', CTX, { webContentsId: 7, authGeneration: 4 })).kind).toBe('none')
    expect(audit).toHaveBeenCalledWith('grant.revoked', expect.objectContaining({ reason: 'sign_out' }))
  })

  it('list is renderer-safe: no args hash, no request data', () => {
    const { store } = makeStore()
    store.issue(issueInput(NOTE, 'task'))
    const [summary] = store.list()
    expect(Object.keys(summary!).sort()).toEqual(['actionClass', 'actionId', 'expiresAt', 'grantId', 'scope'])
  })
})
