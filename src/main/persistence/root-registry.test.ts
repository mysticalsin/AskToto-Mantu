import { afterEach, describe, expect, it, vi } from 'vitest'
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron')

import { RootRegistry, type RootScopeBinding } from './root-registry'

function authority(generation = 'generation-1', maxHeldRoots = 4) {
  const scopes = new WeakMap<object, RootScopeBinding>()
  let active = true
  const scope = Object.freeze({})
  const binding: RootScopeBinding = Object.freeze({
    profileNamespace: 'profile-main',
    principalAssociation: 'principal-hash',
    generation,
    nativeKeyAccess: 'allowed',
    legacyFileKeyAccess: 'authorized',
    maxHeldRoots,
    isCurrent: () => active
  })
  scopes.set(scope, binding)
  return {
    scope,
    binding,
    scopes,
    retire: () => {
      active = false
    }
  }
}

describe('persistence root registry', () => {
  let base: string | undefined

  afterEach(async () => {
    if (base) await rm(base, { recursive: true, force: true })
    base = undefined
  })

  it('does not create any path while reopening a missing generation', async () => {
    base = await mkdtemp(join(tmpdir(), 'metis-root-registry-'))
    const owner = authority()
    const roots = new RootRegistry({
      userDataRoot: () => base!,
      resolveScope: (scope) => owner.scopes.get(scope),
      bindGatewayRoot: async () => undefined
    })

    await expect(roots.openExisting(owner.scope, 'meeting-missing')).rejects.toThrow()
    await expect(lstat(join(base, 'persistence-v2'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('holds one writer lease and permanently retires the exact scope after an ABA restoration', async () => {
    base = await mkdtemp(join(tmpdir(), 'metis-root-registry-'))
    const owner = authority()
    const roots = new RootRegistry({
      userDataRoot: () => base!,
      resolveScope: (scope) => owner.scopes.get(scope),
      bindGatewayRoot: async () => undefined
    })
    const root = await roots.create(owner.scope, 'meeting-one')
    const writer = await roots.acquireWriter(owner.scope, root)
    await expect(roots.acquireWriter(owner.scope, root)).rejects.toMatchObject({ code: 'EEXIST' })

    roots.retireScope(owner.scope)
    expect(() => root.assertCurrent()).toThrow(/retired/i)
    await writer.release()
    await roots.closeRoot(owner.scope, root)

    const successor = authority('generation-2')
    const reopened = await roots.openExisting(successor.scope, 'meeting-one')
    const nextWriter = await roots.acquireWriter(successor.scope, reopened)
    await expect(nextWriter.assertPhysicalCurrent()).resolves.toBeUndefined()
    await nextWriter.release()
    await roots.closeRoot(successor.scope, reopened)
  })

  it('closes rejected gateway opens and enforces the configured max plus one root descriptor limit', async () => {
    base = await mkdtemp(join(tmpdir(), 'metis-root-registry-'))
    const owner = authority('generation-1', 1)
    let rejectGateway = true
    const roots = new RootRegistry({
      userDataRoot: () => base!,
      resolveScope: (scope) => owner.scopes.get(scope),
      bindGatewayRoot: async () => {
        if (rejectGateway) throw new Error('gateway rejected root')
      }
    })

    await expect(roots.create(owner.scope, 'meeting-one')).rejects.toThrow('gateway rejected root')
    rejectGateway = false
    const root = await roots.openExisting(owner.scope, 'meeting-one')
    await expect(roots.openExisting(owner.scope, 'meeting-one')).rejects.toThrow(/descriptor limit/i)
    await roots.closeRoot(owner.scope, root)
    const reopened = await roots.openExisting(owner.scope, 'meeting-one')
    await roots.closeRoot(owner.scope, reopened)
  })
})
