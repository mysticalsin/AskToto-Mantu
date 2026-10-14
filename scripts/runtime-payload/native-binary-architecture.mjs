import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { assertMachOArchitectures } from '../lib/macho-architecture.mjs'

const MAX_PE_HEADER_OFFSET = 1_048_576

async function readExact(handle, length, position, label) {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  if (bytesRead !== length) throw new Error(`RUNTIME_NATIVE_HEADER_TRUNCATED:${label}`)
  return buffer
}

/** Validate the actual executable header; process.arch alone is not evidence under translation. */
export async function assertNativeBinaryArchitecture(path, platform, arch) {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('RUNTIME_NATIVE_FILE_NOT_REGULAR')
  const noFollow = constants.O_NOFOLLOW ?? 0
  const handle = await open(path, constants.O_RDONLY | noFollow)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      throw new Error('RUNTIME_NATIVE_FILE_CHANGED')
    if (platform === 'darwin') {
      const length = Math.min(opened.size, 520)
      const header = await readExact(handle, length, 0, 'MACHO')
      assertMachOArchitectures(header, [arch], 'llama runtime native file')
      return
    }
    if (platform !== 'win32' || arch !== 'x64') throw new Error('RUNTIME_NATIVE_TARGET_UNSUPPORTED')
    const dos = await readExact(handle, 64, 0, 'PE_DOS')
    if (dos[0] !== 0x4d || dos[1] !== 0x5a) throw new Error('RUNTIME_NATIVE_PE_MZ_INVALID')
    const peOffset = dos.readUInt32LE(0x3c)
    if (peOffset < 64 || peOffset > MAX_PE_HEADER_OFFSET || peOffset + 6 > opened.size)
      throw new Error('RUNTIME_NATIVE_PE_OFFSET_INVALID')
    const pe = await readExact(handle, 6, peOffset, 'PE')
    if (pe.readUInt32LE(0) !== 0x00004550 || pe.readUInt16LE(4) !== 0x8664)
      throw new Error('RUNTIME_NATIVE_PE_X64_REQUIRED')
  } finally {
    await handle.close()
  }
}
