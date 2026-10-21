import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeFolderWritable } from './folder-writable'

describe('probeFolderWritable', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metis-writable-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('accepts a writable folder and leaves nothing behind', async () => {
    expect(await probeFolderWritable(dir)).toBe(true)
    expect(readdirSync(dir)).toEqual([])
  })

  it('refuses a missing folder', async () => {
    expect(await probeFolderWritable(join(dir, 'missing'))).toBe(false)
  })

  it('refuses a path that is a file, not a folder', async () => {
    const file = join(dir, 'not-a-folder')
    writeFileSync(file, '')
    expect(await probeFolderWritable(file)).toBe(false)
  })
})
