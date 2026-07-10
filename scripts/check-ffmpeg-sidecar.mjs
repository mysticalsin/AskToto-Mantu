#!/usr/bin/env node
/** Verify the reviewed LGPL FFmpeg import-decoder sidecar before packaging. */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const target = process.argv[2] || process.platform
const arch = target === 'win' ? 'x64' : process.arch
const platform = target === 'win' ? 'win32' : target === 'mac' ? 'darwin' : process.platform
const file = join('resources', 'ffmpeg', `${platform}-${arch}`, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const manifest = JSON.parse(readFileSync(join('resources', 'ffmpeg', 'manifest.json'), 'utf8'))
const key = `${platform}-${arch}/${platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'}`
const expected = manifest.binaries?.[key]?.sha256

if (!expected) throw new Error(`No reviewed FFmpeg manifest entry for ${key}.`)
const stat = statSync(file)
if (platform !== 'win32' && !(stat.mode & 0o111)) throw new Error(`${file} is not executable.`)
const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
if (actual !== expected) throw new Error(`${file} hash mismatch: expected ${expected}, got ${actual}.`)
// Spawning the binary to read its license banner only works when the target
// platform matches the actual host — a foreign-platform executable (PE on
// macOS/Linux, Mach-O on Windows) can't run locally, so cross-verification
// falls back to the sha256 check above.
if (platform === process.platform) {
  const result = spawnSync(file, ['-L'], { encoding: 'utf8' })
  const license = `${result.stdout || ''}\n${result.stderr || ''}`
  if (!/GNU Lesser General Public\s+License/i.test(license) || /nonfree parts compiled|--enable-gpl/i.test(license)) {
    throw new Error(`${file} is not the reviewed LGPL-only decoder binary.`)
  }
}
console.log(`[check:ffmpeg] OK — ${key} (${actual.slice(0, 12)}…)`)
