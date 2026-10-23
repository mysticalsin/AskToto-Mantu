import { describe, expect, it } from 'vitest'
import { createDocumentGrants } from './document-grants'
import { createSnapshotStore } from './snapshot-store'
import { memoryIo, testOpen, testSeal, type Env } from './__fixtures__/context-grants-fixtures'

async function setup() {
  const env: Env = { owner: 'owner-a', generation: 0, session: 's1', now: 1_000 }
  const store = createSnapshotStore({
    io: memoryIo(),
    seal: testSeal,
    open: testOpen,
    owner: () => env.owner,
    generation: () => env.generation,
    now: () => env.now
  })
  const grants = createDocumentGrants({
    store,
    owner: () => env.owner,
    generation: () => env.generation,
    sessionId: () => env.session,
    now: () => env.now,
    ttlMs: 60_000
  })
  const snap = await store.request({ gesture: 'typed-screen-intent', kind: 'document' }, async () => ({
    sourceId: 'window:42',
    observationId: 'obs-7',
    generation: 0,
    capturedAt: 900,
    text: 'The whole synthetic document body.',
    app: 'Synthetic Reader'
  }))
  if (!snap.ok) throw new Error('setup')
  return { env, store, grants, snapshotId: snap.snapshot.snapshotId }
}

describe('whole-document grants', () => {
  it('records provenance: app, source, observation, when observed, which gesture', async () => {
    const { grants, snapshotId } = await setup()
    const r = grants.grant({ snapshotId, gesture: 'hold-to-talk-screen-intent' })
    expect(r.ok).toBe(true)
    const [g] = grants.active()
    expect(g.provenance).toEqual({
      app: 'Synthetic Reader',
      sourceId: 'window:42',
      observationId: 'obs-7',
      observedAt: 900,
      grantedAt: 1_000,
      gesture: 'hold-to-talk-screen-intent'
    })
    expect(grants.isGranted(snapshotId)).toBe(true)
    expect(JSON.stringify(grants.active().map((x) => x.provenance))).not.toContain('whole synthetic document')
  })

  it('refuses a grant for a snapshot that is not held, and a non-owner gesture', async () => {
    const { grants, snapshotId } = await setup()
    expect(grants.grant({ snapshotId: 'nope', gesture: 'capture-button' })).toEqual({ ok: false, reason: 'not-found' })
    expect(grants.grant({ snapshotId, gesture: 'ambient' as never })).toEqual({ ok: false, reason: 'invalid' })
  })

  it('ends on stop, sign-out, owner switch, session end and TTL', async () => {
    const cases: Array<[string, (e: Env) => void]> = [
      ['stop', (e) => void (e.generation = 1)],
      ['sign-out', (e) => void (e.owner = null)],
      ['owner switch', (e) => void (e.owner = 'owner-b')],
      ['session end', (e) => void (e.session = 's2')],
      ['ttl', (e) => void (e.now += 60_001)]
    ]
    for (const [, change] of cases) {
      const { env, grants, snapshotId } = await setup()
      grants.grant({ snapshotId, gesture: 'capture-button' })
      change(env)
      expect(grants.active()).toEqual([])
    }
  })

  it('revoke and revokeAll end it at once', async () => {
    const { grants, snapshotId } = await setup()
    const r = grants.grant({ snapshotId, gesture: 'capture-button' })
    if (!r.ok) throw new Error('setup')
    expect(grants.revoke(r.grantId)).toBe(true)
    expect(grants.active()).toEqual([])
    grants.grant({ snapshotId, gesture: 'capture-button' })
    grants.revokeAll('stop')
    expect(grants.active()).toEqual([])
  })

  it('deleting the snapshot ends its grant', async () => {
    const { grants, store, snapshotId } = await setup()
    grants.grant({ snapshotId, gesture: 'capture-button' })
    await store.remove(snapshotId)
    expect(grants.active()).toEqual([])
  })
})
