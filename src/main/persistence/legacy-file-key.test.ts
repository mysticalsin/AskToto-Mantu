import { afterEach, describe, expect, it, vi } from 'vitest'
import { link, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron')

import { RootRegistry, type RootScopeBinding } from './root-registry'
import { createProfileBoundLegacyFileKeyAccess } from './legacy-file-key'

describe('profile-bound legacy file-key access', () => {
  let base: string | undefined

  afterEach(async () => {
    if (base) await rm(base, { recursive: true, force: true })
    base = undefined
  })

  it('reads only an admitted original profile, with no process-global cached key', async () => {
    base = await mkdtemp(join(tmpdir(), 'metis-legacy-key-'))
    const scopes = new WeakMap<object, RootScopeBinding>()
    const owner = (profileNamespace: string, allowed: 'authorized' | 'denied') => {
      const scope = Object.freeze({})
      const binding: RootScopeBinding = Object.freeze({
        profileNamespace,
        principalAssociation: `principal-${profileNamespace}`,
        generation: `generation-${profileNamespace}`,
        nativeKeyAccess: 'allowed',
        legacyFileKeyAccess: allowed,
        maxHeldRoots: 4,
        isCurrent: () => true
      })
      scopes.set(scope, binding)
      return scope
    }
    const roots = new RootRegistry({
      userDataRoot: () => base!,
      resolveScope: (scope) => scopes.get(scope),
      bindGatewayRoot: async () => undefined
    })
    const originalScope = owner('profile-original', 'authorized')
    const originalRoot = await roots.create(originalScope, 'meeting-original')
    const legacyKey = Buffer.alloc(32, 0x5a)
    const legacyPath = join(base, 'secret-key.bin')
    await writeFile(legacyPath, legacyKey, { mode: 0o600 })

    const access = createProfileBoundLegacyFileKeyAccess({ roots })
    const lease = await access.open(originalScope, originalRoot)
    let supplied: Uint8Array | undefined
    await lease.withKey((key) => {
      supplied = key
      expect(Object.getPrototypeOf(key)).toBe(Uint8Array.prototype)
      expect(key.byteLength).toBe(32)
      expect(Buffer.from(key)).toEqual(legacyKey)
    })
    expect([...supplied!]).toEqual(Array.from({ length: 32 }, () => 0))

    const otherScope = owner('profile-other', 'denied')
    const otherRoot = await roots.create(otherScope, 'meeting-other')
    await expect(access.open(otherScope, originalRoot)).rejects.toThrow(/capability unavailable/i)
    await expect(access.open(otherScope, otherRoot)).rejects.toThrow(/no admitted origin/i)
    await expect(readFile(legacyPath)).resolves.toEqual(legacyKey)
    await lease.dispose()

    const alias = join(base, 'foreign-legacy-key-alias')
    await link(legacyPath, alias)
    await expect(access.open(originalScope, originalRoot)).rejects.toThrow(/absent or invalid/i)
    await unlink(alias)
  })
})
