import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createFileConnectorAccountStore, createMemoryConnectorAccountStore } from './account-store'

const SCOPE_KEY = 'a'.repeat(64)

describe('connector account stores', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('partitions persisted registry data by connector kind and hashed owner scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-connector-accounts-'))
    roots.push(root)
    const store = createFileConnectorAccountStore(() => root)
    await store.save('outlook', SCOPE_KEY, { accounts: [] })
    const path = join(root, 'connector-accounts', 'outlook', `${SCOPE_KEY}.json`)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ accounts: [] })
    expect(await store.load('outlook', SCOPE_KEY)).toEqual({ accounts: [] })
  })

  it('rejects a path-like scope key before touching disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-connector-accounts-'))
    roots.push(root)
    const store = createFileConnectorAccountStore(() => root)
    await expect(store.load('outlook', '../../secret-key' as never)).rejects.toThrow(/unsafe connector account scope/i)
  })

  it('isolates memory test records by kind and scope', async () => {
    const store = createMemoryConnectorAccountStore()
    await store.save('outlook', SCOPE_KEY, { accounts: [{ id: 'one' }] })
    await store.save('outlook', 'b'.repeat(64), { accounts: [{ id: 'two' }] })
    await expect(store.load('outlook', SCOPE_KEY)).resolves.toEqual({ accounts: [{ id: 'one' }] })
    await expect(store.load('outlook', 'b'.repeat(64))).resolves.toEqual({ accounts: [{ id: 'two' }] })
  })
})
