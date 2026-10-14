import { constants, type Stats } from 'node:fs'
import { lstat, open, link, unlink, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  preparePrivateCurrentUserAcl,
  readManagedPolicyAuthorityFile,
  verifyPrivateCurrentUserAcl
} from '../win-security'
import { type PolicyHighWater } from './resource-policy'

const FILE = 'persistence-policy-high-water.v1.json'
const MAX_BYTES = 2048
type ReadResult = { status: 'ok'; value: PolicyHighWater | null } | { status: 'invalid' }
const commitTails = new Map<string, Promise<void>>()

function sameVersion(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}

function sameObject(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
}

function parse(bytes: Uint8Array): PolicyHighWater | null {
  if (bytes.byteLength > MAX_BYTES) throw new Error('high-water file exceeds its bound')
  const source = Buffer.from(bytes).toString('utf8')
  const value: unknown = JSON.parse(source)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid high-water file')
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).sort().join(',') !== 'epoch,payloadSha256,version' ||
    !Number.isSafeInteger(record.epoch) ||
    (record.epoch as number) <= 0 ||
    !Number.isSafeInteger(record.version) ||
    (record.version as number) <= 0 ||
    typeof record.payloadSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.payloadSha256)
  )
    throw new Error('invalid high-water file')
  if (
    JSON.stringify({
      epoch: record.epoch,
      version: record.version,
      payloadSha256: record.payloadSha256
    }) !== source
  )
    throw new Error('high-water file is not canonical JSON')
  return Object.freeze({
    epoch: record.epoch as number,
    version: record.version as number,
    payloadSha256: record.payloadSha256
  })
}

/** Bounded per-user anti-rollback store; no input path or renderer-controlled file name is accepted. */
export class PersistencePolicyHighWaterStore {
  private readonly path: string

  constructor(userDataRoot: string) {
    this.path = join(userDataRoot, FILE)
  }

  async read(isCurrent: () => boolean): Promise<ReadResult> {
    try {
      if (!isCurrent()) return { status: 'invalid' }
      let before: Stats
      try {
        before = await lstat(this.path)
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? { status: 'ok', value: null }
          : { status: 'invalid' }
      }
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        before.size < 1 ||
        before.size > MAX_BYTES
      )
        return { status: 'invalid' }
      if (process.platform !== 'win32' && ((before.mode & 0o077) !== 0 || before.uid !== process.getuid?.()))
        return { status: 'invalid' }
      const read = await readManagedPolicyAuthorityFile(this.path, MAX_BYTES, false)
      if (read.status !== 'present' || !isCurrent()) return { status: 'invalid' }
      if (process.platform === 'win32' && !(await verifyPrivateCurrentUserAcl(this.path))) return { status: 'invalid' }
      const after = await lstat(this.path)
      if (!sameVersion(before, after) || after.nlink !== 1 || !isCurrent()) return { status: 'invalid' }
      return { status: 'ok', value: parse(read.bytes) }
    } catch {
      return { status: 'invalid' }
    }
  }

  /** Commit before policy publication. Existing bytes are replaced only after an exact-version read. */
  async commit(previous: PolicyHighWater | null, next: PolicyHighWater, isCurrent: () => boolean): Promise<boolean> {
    const predecessor = commitTails.get(this.path) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = predecessor.then(() => gate)
    commitTails.set(this.path, tail)
    await predecessor
    try {
      return await this.commitSerial(previous, next, isCurrent)
    } finally {
      release()
      if (commitTails.get(this.path) === tail) commitTails.delete(this.path)
    }
  }

  private async commitSerial(
    previous: PolicyHighWater | null,
    next: PolicyHighWater,
    isCurrent: () => boolean
  ): Promise<boolean> {
    const currentRead = await this.read(isCurrent)
    if (currentRead.status !== 'ok' || !isCurrent()) return false
    if (JSON.stringify(currentRead.value) !== JSON.stringify(previous)) return false
    const bytes = Buffer.from(JSON.stringify(next), 'utf8')
    if (bytes.byteLength > MAX_BYTES) return false
    const temporary = join(this.path, '..', `.${FILE}.${randomBytes(12).toString('hex')}.tmp`)
    let file: Awaited<ReturnType<typeof open>> | undefined
    let created: Stats | undefined
    try {
      file = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600
      )
      await file.writeFile(bytes)
      await file.sync()
      created = await file.stat()
      if (process.platform === 'win32' && !(await preparePrivateCurrentUserAcl(temporary))) return false
      if (!isCurrent()) return false
      const [pathVersion, heldVersion] = await Promise.all([lstat(temporary), file.stat()])
      if (
        !created ||
        !sameVersion(created, pathVersion) ||
        !sameVersion(created, heldVersion) ||
        pathVersion.nlink !== 1
      )
        return false
      if (process.platform === 'win32' && !(await verifyPrivateCurrentUserAcl(temporary))) return false
      if (!isCurrent()) return false
      const existing = await lstat(this.path).catch((error: NodeJS.ErrnoException) =>
        error.code === 'ENOENT' ? null : Promise.reject(error)
      )
      if (previous === null) {
        if (existing) return false
        // Hard-link publication is exclusive, so an unexpected pre-existing high-water is never replaced.
        await link(temporary, this.path)
        await unlink(temporary)
      } else {
        if (!existing || !existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) return false
        const verifyPrevious = await this.read(isCurrent)
        if (
          verifyPrevious.status !== 'ok' ||
          JSON.stringify(verifyPrevious.value) !== JSON.stringify(previous) ||
          !isCurrent()
        )
          return false
        const immediatelyBeforeRename = await lstat(this.path)
        if (!sameVersion(existing, immediatelyBeforeRename) || !isCurrent()) return false
        await rename(temporary, this.path)
      }
      const [published, held] = await Promise.all([lstat(this.path), file.stat()])
      if (
        !created ||
        !published.isFile() ||
        published.isSymbolicLink() ||
        published.nlink !== 1 ||
        !sameObject(created, published) ||
        !sameObject(created, held) ||
        !isCurrent()
      )
        return false
      const directory = await open(join(this.path, '..'), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
      if (process.platform === 'win32' && !(await verifyPrivateCurrentUserAcl(this.path))) return false
      const readback = await this.read(isCurrent)
      return readback.status === 'ok' && JSON.stringify(readback.value) === JSON.stringify(next) && isCurrent()
    } catch {
      return false
    } finally {
      bytes.fill(0)
      await file?.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
    }
  }
}
