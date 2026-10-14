import { gzipSync } from 'node:zlib'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { constants } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertRuntimeFileClosure } from './runtime-provenance'
import { extractRuntimeTarGzip } from './runtime-tar'

interface TestEntry {
  readonly path: string
  readonly bytes: Buffer
  readonly type?: number
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii')
}

function tarHeader(entry: TestEntry): Buffer {
  const header = Buffer.alloc(512)
  header.write(entry.path, 0, 100, 'utf8')
  writeOctal(header, 100, 8, 0o644)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, entry.bytes.byteLength)
  writeOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header[156] = entry.type ?? 0x30
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')
  const checksum = header.reduce((sum, value) => sum + value, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return header
}

function archiveBytes(entries: readonly TestEntry[]): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    chunks.push(tarHeader(entry), entry.bytes)
    const padding = (512 - (entry.bytes.byteLength % 512)) % 512
    if (padding) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}

async function extract(
  entries: readonly TestEntry[]
): Promise<readonly { path: string; bytes: number; sha256: string; executable: boolean }[]> {
  const root = await mkdtemp(join(tmpdir(), 'metis-runtime-tar-'))
  try {
    const path = join(root, 'payload.tar.gz')
    await writeFile(path, archiveBytes(entries))
    return await extractRuntimeTarGzip(
      path,
      {
        async addFile(_name, data): Promise<void> {
          for await (const _chunk of data) {
          }
        }
      },
      new AbortController().signal
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('strict optional runtime tar closure', () => {
  it.skipIf(!constants.O_NOFOLLOW || !constants.O_NONBLOCK)('accepts a normalized file member', async () => {
    const bytes = Buffer.from('signed payload')
    const extracted = await extract([{ path: 'runtime/host.js', bytes }])
    expect(extracted).toEqual([
      expect.objectContaining({ path: 'runtime/host.js', bytes: bytes.byteLength, executable: false })
    ])
    expect(() =>
      assertRuntimeFileClosure(
        {
          files: extracted.map(({ path, bytes: size, sha256, executable }) => ({
            path,
            bytes: size,
            sha256,
            executable
          }))
        } as never,
        extracted
      )
    ).not.toThrow()
  })

  it.skipIf(!constants.O_NOFOLLOW || !constants.O_NONBLOCK)(
    'rejects traversal and non-regular tar members',
    async () => {
      await expect(extract([{ path: '../outside', bytes: Buffer.from('x') }])).rejects.toThrow('RUNTIME_TAR_INVALID')
      await expect(extract([{ path: 'runtime/link', bytes: Buffer.alloc(0), type: 0x32 }])).rejects.toThrow(
        'RUNTIME_TAR_INVALID'
      )
    }
  )

  it.skipIf(!constants.O_NOFOLLOW || !constants.O_NONBLOCK)(
    'rejects duplicate and case-colliding inventory membership',
    async () => {
      const first = Buffer.from('first')
      const second = Buffer.from('second')
      const extracted = await extract([
        { path: 'Runtime/host.js', bytes: first },
        { path: 'runtime/host.js', bytes: second }
      ])
      const inventory = {
        files: extracted.map(({ path, bytes, sha256, executable }) => ({ path, bytes, sha256, executable }))
      }
      expect(() => assertRuntimeFileClosure(inventory as never, extracted)).toThrow(
        'RUNTIME_ARCHIVE_FILE_CLOSURE_MISMATCH'
      )
    }
  )
})
