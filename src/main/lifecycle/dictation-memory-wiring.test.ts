import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OwnerSessionRef, OwnerSessionRevokeReason } from '@shared/contracts/owner-session'
import { DICTATION_MEMORY_IPC } from '@shared/dictation-memory'
import { currentDictationMemory, installDictationMemory } from '../features/dictation'
import { makeTempRoot, syntheticKeys } from '../features/dictation/__fixtures__/dictation-memory-fixtures'
import type { AuthorizeSender } from '../ipc/sender-auth'
import { readModuleSource } from '../../test-helpers/module-source'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import { DEFAULT_VOICE_ACTIONS_SETTINGS } from '@shared/voice-actions-settings'
import { configureMemoryPartitions, resetMemoryAccessForTests } from '../memory-partition/memory-access'
import type { MemoryAccess, MemoryPartitions } from '../memory-partition/memory-partitions'
import type { SettingsObservation } from '../settings-observation'
import { bootstrapDictationMemory, dictationMemoryAllowed, dictationTextAtRest } from './dictation-memory-wiring'

const PART_A = 'a1'.repeat(12)
const PART_B = 'b2'.repeat(12)
const observe = (patch: Record<string, unknown> = {}, readable = true): SettingsObservation => ({
  settings: {
    ...DEFAULT_SETTINGS,
    voiceActions: {
      ...DEFAULT_VOICE_ACTIONS_SETTINGS,
      dictation: { ...DEFAULT_VOICE_ACTIONS_SETTINGS.dictation, enabled: true }
    },
    ...patch
  } as never,
  readable,
  epoch: 1
})
const summaryOnly = { enterpriseLive: { managed: true, inferenceMode: 'legacy', summaryOnly: true } }
const roots: Array<{ remove(): void }> = []
afterEach(() => {
  installDictationMemory(null)
  resetMemoryAccessForTests()
  while (roots.length) roots.pop()?.remove()
})

function wiring(
  over: {
    partition?: () => string | null
    signedIn?: boolean
    settings?: () => SettingsObservation | null
    onPartitionChange?: (cb: () => void) => () => void
    qaIdentity?: boolean
  } = {}
) {
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
    readSettings: over.settings ?? (() => observe()),
    qaIdentity: over.qaIdentity ?? false,
    partition: 'partition' in over ? over.partition : () => PART_A,
    onPartitionChange: over.onPartitionChange,
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

describe('dictationMemoryAllowed (G26)', () => {
  it('needs sign-in, readable settings, dictation effectively on and no managed summary-only profile', () => {
    expect(dictationMemoryAllowed(observe(), true, false)).toBe(true)
    expect(dictationMemoryAllowed(observe(), false, false)).toBe(false)
    expect(dictationMemoryAllowed(null, true, false)).toBe(false)
    expect(dictationMemoryAllowed(observe({}, false), true, false)).toBe(false)
    expect(dictationMemoryAllowed(observe(summaryOnly), true, false)).toBe(false)
    // managed but not summary-only keeps text, as the meeting journal does
    expect(
      dictationMemoryAllowed(
        observe({ enterpriseLive: { managed: true, inferenceMode: 'legacy', summaryOnly: false } }),
        true,
        false
      )
    ).toBe(true)
  })

  it('follows the build default when the person has not chosen: on in the QA identity, off in release (Preview)', () => {
    const unset = observe({
      voiceActions: {
        ...DEFAULT_VOICE_ACTIONS_SETTINGS,
        dictation: { ...DEFAULT_VOICE_ACTIONS_SETTINGS.dictation, enabled: null }
      }
    })
    expect(dictationMemoryAllowed(unset, true, true)).toBe(true)
    expect(dictationMemoryAllowed(unset, true, false)).toBe(false)
  })
})

describe('dictation memory wiring (G26)', () => {
  it("journals and dictionary live in G19's partition in force: with none open nothing is recorded or learned", async () => {
    const access: { value: MemoryAccess } = {
      value: { status: 'ok', partitionId: PART_A, relRoot: '.brain-p-x', legacy: false }
    }
    const fake: MemoryPartitions = {
      access: () => access.value,
      activate: async () => access.value,
      onChange: () => () => undefined
    }
    configureMemoryPartitions(fake)
    const w = wiring({ partition: undefined })
    // the default partition resolver is memoryAccess(), not a derivation of its own
    w.memory.sink.segmentRecognized('turn-1', 'a words')
    w.memory.sink.turnEnded('turn-1')
    await w.memory.flush()
    access.value = { status: 'signed-out' }
    w.memory.sink.segmentRecognized('turn-2', 'refused words')
    await w.memory.flush()
    expect(await w.memory.recoveryTake()).toBeNull()
    expect(await w.memory.dictionaryList()).toEqual({ status: 'unavailable', entries: [] })
    access.value = { status: 'ok', partitionId: PART_A, relRoot: '.brain-p-x', legacy: false }
    expect((await w.memory.recoveryTake())?.items.map((i) => i.text)).toEqual(['a words'])
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

  it('an account switch shows an empty partition and leaves the other partition untouched', async () => {
    const part = { id: PART_A as string | null }
    const w = wiring({ partition: () => part.id })
    w.memory.sink.segmentRecognized('turn-1', 'ask tota about the plan')
    w.memory.sink.turnEnded('turn-1')
    await w.memory.flush()
    part.id = PART_B
    expect(await w.memory.recoveryTake()).toBeNull()
    expect(await w.memory.dictionaryList()).toEqual({ status: 'ok', entries: [] })
    expect(await w.memory.dictionaryClear()).toEqual({ ok: true, count: 0 })
    part.id = PART_A
    const [item] = (await w.memory.recoveryTake())!.items
    expect(item.text).toBe('ask tota about the plan')
    await w.memory.recoveryResolve({ id: item.id, correctedText: 'ask Toto about the plan' })
    expect((await w.memory.dictionaryList()).entries).toHaveLength(1)
    part.id = PART_B
    expect((await w.memory.dictionaryList()).entries).toEqual([])
    part.id = PART_A
    expect((await w.memory.dictionaryList()).entries).toHaveLength(1)
  })

  it('a partition change forgets the correction window', () => {
    let change: () => void = () => undefined
    const w = wiring({
      onPartitionChange: (cb) => {
        change = cb
        return () => undefined
      }
    })
    w.memory.sink.inserted('turn-1', 'ask tota about it')
    expect(w.memory.spansRecent().spans).toHaveLength(1)
    change()
    expect(w.memory.spansRecent().spans).toEqual([])
  })

  it('follows the effective dictation setting and refuses a managed summary-only profile', async () => {
    const published = { value: observe() as SettingsObservation | null }
    const w = wiring({ settings: () => published.value })
    w.memory.sink.segmentRecognized('turn-1', 'allowed words')
    w.memory.sink.turnEnded('turn-1')
    await w.memory.flush()
    const journalDir = join(w.root.path, 'dictation-memory', 'journal')
    expect(await readdir(journalDir)).toHaveLength(1)
    published.value = observe(summaryOnly)
    w.memory.sink.segmentRecognized('turn-2', 'refused words')
    w.memory.sink.inserted('turn-2', 'ask tota about it')
    await w.memory.flush()
    expect(await readdir(journalDir)).toHaveLength(1)
    expect(w.memory.spansRecent().spans).toEqual([])
    published.value = observe({
      voiceActions: {
        ...DEFAULT_VOICE_ACTIONS_SETTINGS,
        dictation: { ...DEFAULT_VOICE_ACTIONS_SETTINGS.dictation, enabled: false }
      }
    })
    w.memory.sink.segmentRecognized('turn-3', 'refused words')
    await w.memory.flush()
    expect(await readdir(journalDir)).toHaveLength(1)
  })

  it('a summary-only profile leaves no dictated text at rest: the launch purge deletes the journal and the dictionary', async () => {
    const dir = makeTempRoot()
    roots.push(dir)
    const published = { value: observe() as SettingsObservation | null }
    const build = () => {
      const memory = bootstrapDictationMemory({
        ipcMain: { handle: () => undefined },
        authorizeSender: (() => null) as unknown as AuthorizeSender,
        requireAuth: () => true,
        ownerSession: { onRevoked: () => () => undefined },
        userDataPath: () => dir.path,
        readSettings: () => published.value,
        qaIdentity: false,
        partition: () => PART_A,
        onPartitionChange: () => () => undefined,
        keys: syntheticKeys(),
        audit: () => undefined,
        onWillQuit: () => undefined
      })
      return memory
    }
    const first = build()
    first.sink.segmentRecognized('turn-1', 'ask tota about it')
    first.sink.inserted('turn-0', 'ask tota about it')
    const span = first.spansRecent().spans[0]
    await first.spansCorrect({ id: span.id, correctedText: 'ask Toto about it' })
    first.sink.turnEnded('turn-1')
    await first.flush()
    expect((await first.dictionaryList()).entries).toHaveLength(1)
    published.value = observe(summaryOnly)
    const second = build()
    await second.launch()
    expect(await readdir(join(dir.path, 'dictation-memory', 'journal'))).toEqual([])
    expect((await second.dictionaryList()).entries).toEqual([])
  })

  it('unreadable settings refuse writes but delete nothing', async () => {
    expect(dictationTextAtRest(null)).toBe('unknown')
    expect(dictationTextAtRest(observe({}, false))).toBe('unknown')
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
