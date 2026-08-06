/**
 * Minimal Mach-O reader: list the dynamic libraries an executable will ask dyld to load.
 *
 * Why parse instead of shelling out to `otool -L`: the sidecar gate has to be able to reject a
 * non-portable macOS binary from any host. `otool` only exists on macOS, so an otool-based check
 * is unverifiable and untestable everywhere the maintainers actually work, and it silently
 * degrades to "no check" on the very hosts that seed the release asset. Reading the load commands
 * is a few dozen lines and behaves identically on Windows, Linux and macOS.
 *
 * Scope is deliberately narrow — the dependency list, nothing else. Anything more (symbols,
 * segments, code signature) belongs in a real Mach-O library, not in a packaging gate.
 */

const MH_MAGIC_32 = 0xfeedface
const MH_MAGIC_64 = 0xfeedfacf
const FAT_MAGIC_32 = 0xcafebabe
const FAT_MAGIC_64 = 0xcafebabf

// Dependency-declaring load commands, all sharing the dylib_command layout. Two deliberate
// omissions: LC_ID_DYLIB (0xd) names the image itself rather than something dyld loads, so counting
// it would flag every dylib as its own dependency; LC_PREBOUND_DYLIB (0x10) always accompanies a
// real LC_LOAD_DYLIB for the same library, so counting it would report the same path twice.
// LC_LAZY_LOAD_DYLIB carries no LC_REQ_DYLD high bit, unlike the three below it.
const DYLIB_COMMANDS = new Set([
  0x0000000c, // LC_LOAD_DYLIB
  0x00000020, // LC_LAZY_LOAD_DYLIB
  0x80000018, // LC_LOAD_WEAK_DYLIB
  0x8000001f, // LC_REEXPORT_DYLIB
  0x80000023 // LC_LOAD_UPWARD_DYLIB
])

/** Reader that keeps the byte order of whichever slice is being walked. */
function makeReader(buffer, littleEndian) {
  return (offset) => {
    if (offset < 0 || offset + 4 > buffer.length) {
      throw new Error(`Mach-O read past end of file at offset ${offset}.`)
    }
    return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)
  }
}

/** Read the NUL-terminated dylib path a load command points at, without running off the command. */
function readCString(buffer, start, limit) {
  if (start < 0 || start >= limit || limit > buffer.length) {
    throw new Error(`Mach-O dylib name offset ${start} falls outside its load command.`)
  }
  const end = buffer.indexOf(0, start)
  const stop = end === -1 || end > limit ? limit : end
  return buffer.toString('utf8', start, stop)
}

/** Walk one thin Mach-O image starting at `base`, appending every dylib path it declares. */
function readSlice(buffer, base, out) {
  if (base + 4 > buffer.length) throw new Error(`Mach-O slice at ${base} is truncated.`)
  const magicLE = buffer.readUInt32LE(base)
  const magicBE = buffer.readUInt32BE(base)

  let littleEndian
  let is64
  if (magicLE === MH_MAGIC_64 || magicLE === MH_MAGIC_32) {
    littleEndian = true
    is64 = magicLE === MH_MAGIC_64
  } else if (magicBE === MH_MAGIC_64 || magicBE === MH_MAGIC_32) {
    littleEndian = false
    is64 = magicBE === MH_MAGIC_64
  } else {
    throw new Error(`Not a Mach-O image at offset ${base}.`)
  }

  const read = makeReader(buffer, littleEndian)
  const ncmds = read(base + 16)
  // mach_header is 28 bytes; mach_header_64 adds a 4-byte `reserved` field.
  let offset = base + (is64 ? 32 : 28)

  for (let i = 0; i < ncmds; i++) {
    const cmd = read(offset)
    const cmdsize = read(offset + 4)
    // A zero/undersized cmdsize would spin this loop forever on a corrupt file.
    if (cmdsize < 8 || offset + cmdsize > buffer.length) {
      throw new Error(`Mach-O load command ${i} has an invalid size (${cmdsize}).`)
    }
    if (DYLIB_COMMANDS.has(cmd)) {
      const nameOffset = read(offset + 8)
      out.push(readCString(buffer, offset + nameOffset, offset + cmdsize))
    }
    offset += cmdsize
  }
}

/**
 * Every dylib path the image declares, across all architectures of a universal binary.
 * Returns null when the buffer is not Mach-O at all (a PE sidecar, a shell script), so callers
 * can treat "not a macOS binary" as "nothing to say" rather than as a failure.
 */
export function machoLinkedDylibs(buffer) {
  if (buffer.length < 8) return null
  const magicLE = buffer.readUInt32LE(0)
  const magicBE = buffer.readUInt32BE(0)
  const dylibs = []

  // Fat headers are always big-endian, whatever the slices inside them are.
  if (magicBE === FAT_MAGIC_32 || magicBE === FAT_MAGIC_64) {
    const wide = magicBE === FAT_MAGIC_64
    const nfat = buffer.readUInt32BE(4)
    // Fail closed. Zero slices would otherwise walk no images and return [], which the gate reads as
    // "a valid macOS binary with no dependencies" for a file containing no executable code at all.
    if (nfat === 0) throw new Error('Universal binary declares no architectures.')
    const entrySize = wide ? 32 : 20
    for (let i = 0; i < nfat; i++) {
      const entry = 8 + i * entrySize
      if (entry + entrySize > buffer.length) throw new Error('Universal binary header is truncated.')
      // offset is the 3rd field: cputype, cpusubtype, offset. 64-bit fat entries widen it to 8 bytes,
      // of which only the low half can address a file this side of 4 GiB.
      const sliceOffset = wide ? Number(buffer.readBigUInt64BE(entry + 8)) : buffer.readUInt32BE(entry + 8)
      readSlice(buffer, sliceOffset, dylibs)
    }
    return dylibs
  }

  if (
    magicLE === MH_MAGIC_64 ||
    magicLE === MH_MAGIC_32 ||
    magicBE === MH_MAGIC_64 ||
    magicBE === MH_MAGIC_32
  ) {
    readSlice(buffer, 0, dylibs)
    return dylibs
  }

  return null
}

/**
 * Paths dyld can resolve on a stock macOS install. Everything else — /opt/homebrew, /usr/local,
 * @rpath, @loader_path — depends on something the user's machine is not guaranteed to have, which
 * for a bundled sidecar means it crashes on launch with "Library not loaded".
 */
export function isSystemDylib(path) {
  return path.startsWith('/usr/lib/') || path.startsWith('/System/Library/')
}

/** The subset of `machoLinkedDylibs` that would not resolve on a clean macOS machine. */
export function nonPortableDylibs(buffer) {
  const dylibs = machoLinkedDylibs(buffer)
  if (dylibs === null) return null
  return dylibs.filter((path) => !isSystemDylib(path))
}
