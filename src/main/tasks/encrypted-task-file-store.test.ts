import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TASK_STORE_DECRYPT_FAILED, createEncryptedTaskFileStore } from './encrypted-task-file-store'

// Test cipher only: reversible and recognisable, so the test can prove plaintext never reaches the file.
const encrypt = (data: string) => Buffer.from(Buffer.from(data, 'utf8').toString('base64').split('').reverse().join(''))
const decrypt = (data: Buffer) => {
  const text = Buffer.from(data.toString('utf8').split('').reverse().join(''), 'base64').toString('utf8')
  if (!text.startsWith('{')) throw new Error('bad ciphertext')
  return text
}

describe('createEncryptedTaskFileStore', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'task-store-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const make = () =>
    createEncryptedTaskFileStore({
      file: () => join(dir, 'nested', 'tasks.bin'),
      encrypt,
      decrypt,
      atomicWrite: async (file, data) => writeFile(file, data),
      now: () => 42
    })

  it('reports not-found for a missing archive', async () => {
    expect(await make().read()).toEqual({ kind: 'not-found' })
  })

  it('round-trips an archive and stores it only in encrypted form', async () => {
    const store = make()
    await store.write('{"version":1,"secret":"visible-text"}')
    expect(await store.read()).toEqual({ kind: 'found', serialized: '{"version":1,"secret":"visible-text"}' })
    expect((await readFile(join(dir, 'nested', 'tasks.bin'))).toString('utf8')).not.toContain('visible-text')
  })

  it('reports an unreadable ciphertext as decrypt-failed rather than corrupt data', async () => {
    const store = make()
    await store.write('{"a":1}')
    const file = join(dir, 'nested', 'tasks.bin')
    const bytes = await readFile(file)
    await writeFile(file, Buffer.concat([bytes.subarray(0, 8), Buffer.from('not-the-cipher')]))
    expect(await store.read()).toEqual({ kind: 'unavailable', reason: TASK_STORE_DECRYPT_FAILED })
  })

  it('hands an unmarked file to the codec as an empty document so it is reported corrupt', async () => {
    const store = make()
    await store.write('{"a":1}')
    await writeFile(join(dir, 'nested', 'tasks.bin'), 'plain text')
    expect(await store.read()).toEqual({ kind: 'found', serialized: '' })
  })

  it('moves an archive aside without deleting it and tolerates a missing one', async () => {
    const store = make()
    await store.quarantine()
    await store.write('{"a":1}')
    await store.quarantine()
    expect(await readdir(join(dir, 'nested'))).toEqual(['tasks.bin.corrupt-42'])
    expect(await store.read()).toEqual({ kind: 'not-found' })
  })
})
