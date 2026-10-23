import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { USER_MEMORY_IPC } from '@shared/user-memory'
import { currentUserMemory, installUserMemory } from '../features/user-memory'
import { syntheticKeys } from '../features/user-memory/__fixtures__/user-memory-fixtures'
import { readModuleSource } from '../../test-helpers/module-source'
import { bootstrapUserMemory } from './user-memory-wiring'

const lf = (text: string): string => text.replace(/\r\n/g, '\n')
const dirs: string[] = []
afterEach(() => {
  installUserMemory(null)
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('user memory wiring (G57)', () => {
  it('registers its three channels, installs the memory for the ask path and stores under userData/user-memory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'synthetic-um-wiring-'))
    dirs.push(dir)
    const channels: string[] = []
    const memory = bootstrapUserMemory({
      ipcMain: { handle: (channel: string) => void channels.push(channel) },
      authorizeSender: (() => null) as never,
      requireAuth: () => true,
      userDataPath: () => dir,
      audit: () => undefined,
      keys: syntheticKeys(),
      partition: () => 'a'.repeat(32)
    })
    expect(channels.sort()).toEqual(Object.values(USER_MEMORY_IPC).sort())
    expect(currentUserMemory()).toBe(memory)
    expect(await memory.store.rememberFromSettings('Use metric units')).toBe(true)
    expect((await memory.list()).items).toHaveLength(1)
  })

  it('is composed by the owner-session wiring and read by the ask path, which index.ts only reaches through the context runtime', () => {
    const owner = lf(readModuleSource(__dirname, './owner-session-wiring').text)
    expect(owner).toMatch(/bootstrapUserMemory\(\{/)
    const grants = lf(readModuleSource(join(__dirname, '..', 'features', 'context-grants'), './wiring').text)
    expect(grants).toMatch(/userMemory: currentUserMemory/)
  })
})
