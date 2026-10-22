import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OwnerSessionRef, OwnerSessionRevokeReason } from '@shared/contracts/owner-session'
import { DICTATION_MEMORY_IPC } from '@shared/dictation-memory'
import { currentDictationMemory, installDictationMemory } from '../features/dictation'
import { makeTempRoot, syntheticKeys } from '../features/dictation/__fixtures__/dictation-memory-fixtures'
import type { AuthorizeSender } from '../ipc/sender-auth'
import { readModuleSource } from '../../test-helpers/module-source'
import { bootstrapDictationMemory, dictationPartitionId } from './dictation-memory-wiring'

const OWNER_A = 'a'.repeat(64)
const OWNER_B = 'b'.repeat(64)
const roots: Array<{ remove(): void }> = []
afterEach(() => {
  installDictationMemory(null)
  while (roots.length) roots.pop()?.remove()
})

function wiring(over: { ownerKey?: () => string | null; signedIn?: boolean } = {}) {
  const root = makeTempRoot()
  roots.push(root)
  const handlers = new Map<string, (event: unknown, raw?: unknown) => Promise<unknown>>()
  let revoke: ((ref: OwnerSessionRef, reason: OwnerSessionRevokeReason) => void) | null = null
  let quit: (() => void) | null = null
  const audits: Array<Record<string, unknown>> = []
  const authorizeSender = (() => null) as unknown as AuthorizeSender
  const memory = bootstrapDictationMemory({
    ipcMain: { handle: (channel: string, fn: never) => void handlers.set(channel, fn) },
    authorizeSender,
    requireAuth: () => over.signedIn ?? true,
    ownerSession: {
      onRevoked: (cb) => {
        revoke = cb
        return () => undefined
      }
    },
    userDataPath: () => root.path,
    currentOwnerKey: over.ownerKey ?? (() => OWNER_A),
    keys: syntheticKeys(),
    audit: (record) => audits.push({ ...record }),
    onWillQuit: (cb) => {
      quit = cb
    }
  })
  return {
    memory,
    root,
    handlers,
    audits,
    revoke: () => revoke!({} as OwnerSessionRef, 'sign-out'),
    quit: () => quit!()
  }
}

describe('dictation memory wiring (G26)', () => {
  it('derives an opaque partition from the verified owner key; with no owner it is the local profile', () => {
    expect(dictationPartitionId(OWNER_A)).toMatch(/^[0-9a-f]{32}$/)
    expect(dictationPartitionId(OWNER_A)).not.toContain(OWNER_A.slice(0, 8))
    expect(dictationPartitionId(OWNER_A)).not.toBe(dictationPartitionId(OWNER_B))
    expect(dictationPartitionId(null)).toBe('local')
  })

  it('registers the seven channels, installs itself for the dictation runtime and stores under userData', async () => {
    const w = wiring()
    expect([...w.handlers.keys()].sort()).toEqual(Object.values(DICTATION_MEMORY_IPC).sort())
    expect(currentDictationMemory()).toBe(w.memory)
    w.memory.sink.segmentRecognized('turn-1', 'synthetic words')
    await w.memory.flush()
    expect(await readdir(join(w.root.path, 'dictation-memory', 'journal'))).toHaveLength(1)
    expect(await readdir(join(w.root.path, 'dictation-memory'))).toEqual(expect.arrayContaining(['key.v1', 'journal']))
  })

  it('on sign-out the correction window is forgotten', () => {
    const w = wiring()
    w.memory.sink.inserted('turn-1', 'ask tota about it')
    expect(w.memory.spansRecent().spans).toHaveLength(1)
    w.revoke()
    expect(w.memory.spansRecent().spans).toEqual([])
  })

  it('the partition follows the signed-in owner on every use', async () => {
    const owner = { key: OWNER_A as string | null }
    const w = wiring({ ownerKey: () => owner.key })
    w.memory.sink.segmentRecognized('turn-1', 'a words')
    w.memory.sink.turnEnded('turn-1')
    await w.memory.flush()
    owner.key = OWNER_B
    expect(await w.memory.recoveryTake()).toBeNull()
    owner.key = OWNER_A
    expect((await w.memory.recoveryTake())?.items).toHaveLength(1)
  })

  it('flushes pending writes at will-quit', async () => {
    const w = wiring()
    w.memory.sink.segmentRecognized('turn-1', 'words')
    const flush = vi.spyOn(w.memory, 'flush')
    w.quit()
    expect(flush).toHaveBeenCalled()
  })

  it('is built from the owner-session wiring, not index.ts, and the runtime reads it lazily', () => {
    const owner = readModuleSource(__dirname, './owner-session-wiring').text
    expect(owner).toContain('bootstrapDictationMemory(')
    expect(readModuleSource(__dirname, '../index').text).not.toMatch(/bootstrapDictationMemory|dictation-memory/)
    expect(readModuleSource(__dirname, '../features/dictation/dictation-runtime').text).toContain(
      'currentDictationMemory'
    )
  })
})
