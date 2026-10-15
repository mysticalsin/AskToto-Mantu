import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { hashPinnedArchive } from './runtime-archive'

describe('runtime archive held-descriptor hashing', () => {
  it('opens a raced-in FIFO without blocking before rejecting its type', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-runtime-fifo-'))
    try {
      const path = join(root, 'raced-pipe')
      execFileSync('mkfifo', [path])
      await expect(hashPinnedArchive(path, 1)).rejects.toThrow('RUNTIME_ARCHIVE_SHAPE_MISMATCH')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
