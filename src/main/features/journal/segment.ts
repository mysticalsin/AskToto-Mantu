import { open, readdir, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Journal segment files: seg-<n>.jnl, a sequence of frames. A frame is a 4-byte big-endian payload
 * length followed by the payload (one sealed record).
 *
 * INV-APPEND: a segment is created exclusively ('ax') by the writer that fills it and is only ever
 * appended to by that writer. A new process, or a writer whose write failed, starts the next segment, so
 * a torn frame left by a crash or a failed write is always the last bytes of its segment and never has
 * frames written after it.
 */

export const FRAME_HEADER_BYTES = 4
/** No single record comes near this; a larger length can only be a torn or corrupt header. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

const SEGMENT_NAME = /^seg-([1-9][0-9]{0,8})\.jnl$/

export function segmentName(n: number): string {
  return `seg-${n}.jnl`
}

/** The segment number of a seg-<n>.jnl file name, or null for any other name. */
export function parseSegmentName(name: string): number | null {
  const match = SEGMENT_NAME.exec(name)
  return match ? Number(match[1]) : null
}

/** The session directory's segment numbers in ascending order; empty when the directory does not exist. */
export async function listSegments(dir: string): Promise<number[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  return names
    .map(parseSegmentName)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b)
}

export function encodeFrame(payload: Buffer): Buffer {
  if (payload.length === 0 || payload.length > MAX_FRAME_BYTES) {
    throw new Error(`journal: frame payload of ${payload.length} bytes is out of range`)
  }
  const header = Buffer.alloc(FRAME_HEADER_BYTES)
  header.writeUInt32BE(payload.length, 0)
  return Buffer.concat([header, payload])
}

/** `tornTail` is true when the segment ends in an incomplete or impossible frame; every frame before it is returned. */
export type FrameScan = { payloads: Buffer[]; tornTail: boolean }

export function scanFrames(bytes: Buffer): FrameScan {
  const payloads: Buffer[] = []
  let offset = 0
  while (offset < bytes.length) {
    if (bytes.length - offset < FRAME_HEADER_BYTES) return { payloads, tornTail: true }
    const length = bytes.readUInt32BE(offset)
    const end = offset + FRAME_HEADER_BYTES + length
    if (length === 0 || length > MAX_FRAME_BYTES || end > bytes.length) return { payloads, tornTail: true }
    payloads.push(bytes.subarray(offset + FRAME_HEADER_BYTES, end))
    offset = end
  }
  return { payloads, tornTail: false }
}

/** fsync a directory so a file just created in it survives power loss. Windows cannot open a directory
 *  for fsync and commits the entry with the file's own flush, so the step does not apply there. */
export async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(dir, 'r')
  try {
    await handle.sync()
  } catch (e) {
    // Filesystems that do not support fsync on a directory report EINVAL; their entries need no extra flush.
    if ((e as NodeJS.ErrnoException).code !== 'EINVAL') throw e
  } finally {
    await handle.close()
  }
}

/** The single appender of one segment (INV-APPEND). */
export class SegmentWriter {
  private constructor(
    readonly path: string,
    private readonly handle: FileHandle,
    private bytes: number
  ) {}

  /** Creates seg-<n>.jnl; fails with EEXIST rather than append to a segment another writer left behind. */
  static async create(dir: string, n: number): Promise<SegmentWriter> {
    const path = join(dir, segmentName(n))
    const handle = await open(path, 'ax', 0o600)
    try {
      await syncDirectory(dir)
    } catch (e) {
      await handle.close().catch(() => {})
      throw e
    }
    return new SegmentWriter(path, handle, 0)
  }

  get size(): number {
    return this.bytes
  }

  /** Appends the frames and returns once they are fsynced. */
  async appendDurably(frames: Buffer): Promise<void> {
    await this.handle.appendFile(frames)
    this.bytes += frames.length
    await this.handle.sync()
  }

  async close(): Promise<void> {
    await this.handle.close()
  }
}
