import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SnapshotIo } from './snapshot-store'

const ID = /^[A-Za-z0-9-]{1,64}$/

/**
 * Sealed snapshot files for one owner's memory partition, under `<root>/<hash of the partition id>/`. The partition id
 * is hashed so the directory name carries nothing about the owner, and an id that is not a plain token is refused so a
 * name can never leave the directory. `purge` removes the whole partition directory.
 */
export function createSnapshotFileIo(root: string, partitionId: () => string | null): SnapshotIo {
  const dir = (): string => {
    const id = partitionId()
    if (id === null) throw new Error('no memory partition is open')
    return join(root, createHash('sha256').update(id).digest('hex').slice(0, 24))
  }
  const file = (id: string): string => {
    if (!ID.test(id)) throw new Error('invalid snapshot id')
    return join(dir(), `${id}.sealed`)
  }
  return {
    async write(id, data) {
      const target = file(id)
      await mkdir(dir(), { recursive: true, mode: 0o700 })
      await writeFile(target, data, { mode: 0o600 })
    },
    async read(id) {
      try {
        return await readFile(file(id))
      } catch {
        return null
      }
    },
    async remove(id) {
      await rm(file(id), { force: true })
    },
    async purge() {
      let names: string[] = []
      try {
        names = await readdir(root)
      } catch {
        return
      }
      // Every partition's snapshots end together on sign-out or an owner switch; none outlives its session.
      await Promise.all(names.map((name) => rm(join(root, name), { recursive: true, force: true })))
    }
  }
}
