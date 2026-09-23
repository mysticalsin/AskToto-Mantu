import { execFileSync } from 'node:child_process'

const SPEECH_KEY = 'NSSpeechRecognitionUsageDescription'

/** Read the privacy plist from a specific Mach-O slice, not the containing Electron app bundle. */
export function macHelperSpeechUsage(binary, arch) {
  let dump
  try {
    dump = execFileSync('otool', ['-arch', arch, '-X', '-s', '__TEXT', '__info_plist', binary], {
      encoding: 'utf8'
    })
  } catch {
    return null
  }
  // otool prints a slice address followed by little-endian 32-bit words.
  // The final one to three bytes are printed individually.
  const words = dump.split('\n').filter((line) => /^[0-9a-f]{16}\s+/i.test(line)).flatMap((line) => line.trim().split(/\s+/).slice(1))
  if (!words.length || words.some((word) => !/^(?:[0-9a-f]{2}){1,4}$/i.test(word))) return null
  const plist = Buffer.concat(words.map((word) => {
    const bytes = Buffer.from(word, 'hex')
    return bytes.length > 1 ? bytes.reverse() : bytes
  }))
  try {
    const usage = execFileSync('plutil', ['-extract', SPEECH_KEY, 'raw', '-o', '-', '-'], {
      input: plist,
      encoding: 'utf8'
    }).trim()
    return usage || null
  } catch {
    return null
  }
}

export function assertMacHelperSpeechUsage(binary, arches) {
  for (const arch of arches) {
    if (macHelperSpeechUsage(binary, arch)) continue
    throw new Error(
      `macOS helper ${arch} slice lacks an embedded ${SPEECH_KEY} in __TEXT,__info_plist. ` +
        'Apple Speech authorization will crash the helper; rebuild it with scripts/build-mac-helper.mjs.'
    )
  }
}
