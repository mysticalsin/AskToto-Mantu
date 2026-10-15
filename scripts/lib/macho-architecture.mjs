const CPU_TYPES = { arm64: 0x0100000c, x64: 0x01000007 }

/** Read the exact 64-bit Mach-O slices from a file buffer and reject unknown or unexpected slices. */
export function assertMachOArchitectures(bytes, expectedArchitectures, label = 'Mach-O file') {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 8) throw new Error(`${label}: truncated Mach-O header`)
  const fatMagic = bytes.readUInt32BE(0)
  const thinMagic = bytes.readUInt32LE(0)
  let cpuTypes
  if (fatMagic === 0xcafebabe || fatMagic === 0xcafebabf) {
    if (bytes.byteLength < 8) throw new Error(`${label}: truncated fat Mach-O header`)
    const count = bytes.readUInt32BE(4)
    if (count === 0 || count > 16) throw new Error(`${label}: implausible fat Mach-O slice count ${count}`)
    const entrySize = fatMagic === 0xcafebabe ? 20 : 32
    if (bytes.byteLength < 8 + count * entrySize) throw new Error(`${label}: truncated fat Mach-O architecture table`)
    cpuTypes = Array.from({ length: count }, (_, index) => bytes.readUInt32BE(8 + index * entrySize))
  } else if (thinMagic === 0xfeedfacf) {
    cpuTypes = [bytes.readUInt32LE(4)]
  } else {
    throw new Error(`${label}: not a 64-bit Mach-O image (magic=0x${thinMagic.toString(16)})`)
  }
  const actual = cpuTypes
    .map(
      (cpuType) =>
        Object.keys(CPU_TYPES).find((arch) => CPU_TYPES[arch] === cpuType) ?? `unknown(0x${cpuType.toString(16)})`
    )
    .sort()
  const expected = [...expectedArchitectures].sort()
  if (actual.length !== expected.length || actual.some((arch, index) => arch !== expected[index])) {
    throw new Error(`${label}: expected Mach-O arches [${expected.join(', ')}], got [${actual.join(', ')}]`)
  }
  return actual
}
