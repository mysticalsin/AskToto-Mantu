import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PersistencePolicyHighWaterStore } from './policy-high-water'
import type { PolicyHighWater } from './resource-policy'

const directories: string[] = []

async function privateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'metis-persistence-hwm-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('persistence policy high-water storage', () => {
  it('commits before publication and rejects stale compare-and-swap input', async () => {
    const store = new PersistencePolicyHighWaterStore(await privateDirectory())
    const next: PolicyHighWater = { epoch: 3, version: 2, payloadSha256: 'a'.repeat(64) }

    expect(await store.read(() => true)).toEqual({ status: 'ok', value: null })
    expect(await store.commit(null, next, () => true)).toBe(true)
    expect(await store.read(() => true)).toEqual({ status: 'ok', value: next })

    const stale: PolicyHighWater = { ...next, epoch: 2 }
    expect(await store.commit(stale, { ...next, epoch: 4 }, () => true)).toBe(false)
    expect(await store.read(() => true)).toEqual({ status: 'ok', value: next })
  })

  it('preserves corrupt high-water bytes and refuses to replace them', async () => {
    const directory = await privateDirectory()
    const store = new PersistencePolicyHighWaterStore(directory)
    const path = join(directory, 'persistence-policy-high-water.v1.json')
    const original = Buffer.from('{"epoch":1,"unexpected":true}')
    await writeFile(path, original, { mode: 0o600, flag: 'wx' })

    expect(await store.read(() => true)).toEqual({ status: 'invalid' })
    expect(await store.commit(null, { epoch: 1, version: 1, payloadSha256: 'b'.repeat(64) }, () => true)).toBe(false)
    expect(await readFile(path)).toEqual(original)
  })

  it('serializes competing same-process store instances and rejects the stale second writer', async () => {
    const directory = await privateDirectory()
    const first = new PersistencePolicyHighWaterStore(directory)
    const second = new PersistencePolicyHighWaterStore(directory)
    const initial: PolicyHighWater = { epoch: 3, version: 2, payloadSha256: 'c'.repeat(64) }
    const left: PolicyHighWater = { epoch: 4, version: 3, payloadSha256: 'd'.repeat(64) }
    const right: PolicyHighWater = { epoch: 5, version: 4, payloadSha256: 'e'.repeat(64) }

    expect(await first.commit(null, initial, () => true)).toBe(true)
    const results = await Promise.all([
      first.commit(initial, left, () => true),
      second.commit(initial, right, () => true)
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await first.read(() => true)).toEqual({ status: 'ok', value: results[0] ? left : right })
  })
})
