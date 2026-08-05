#!/usr/bin/env node
/** Verify the reviewed LGPL FFmpeg import-decoder sidecar before packaging. */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const target = process.argv[2] || process.platform
const arch = process.argv[3] || (target === 'win' ? 'x64' : process.arch)
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
if (platform === process.platform && arch === process.arch) {
  const result = spawnSync(file, ['-L'], { encoding: 'utf8' })
  // The sha256 above already proved these are the reviewed bytes, so a failure to
  // RUN the binary is an execution problem — quarantine, a missing exec bit, a
  // foreign arch — not a licensing one. Surface that directly: an unreported
  // spawn failure leaves the banner empty, which then fails the LGPL test below
  // and reports a licence violation for a binary whose licence was never read.
  if (result.error) {
    // Remediation differs per host, and pointing a Windows operator at xattr/chmod just wastes their
    // time: neither exists there, and the real causes are Mark-of-the-Web (the file came from a
    // download and is still marked), AV quarantine, or a payload that is not a loadable PE image.
    const remedy =
      process.platform === 'win32'
        ? `check Mark-of-the-Web (Unblock-File '${file}'), AV quarantine, and that the file is a valid PE image.`
        : `check quarantine (xattr -l '${file}') and the exec bit.`
    throw new Error(
      `${file} matched the reviewed sha256 but could not be executed: ${result.error.message}. ` +
        `This is not a licensing failure — ${remedy}`
    )
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim().slice(0, 300) || '(no stderr)'
    throw new Error(
      `${file} matched the reviewed sha256 but exited ${result.status}` +
        `${result.signal ? ` on signal ${result.signal}` : ''} running -L, so its licence banner ` +
        `could not be read. This is not a licensing failure. stderr: ${stderr}`
    )
  }
  const license = `${result.stdout || ''}\n${result.stderr || ''}`
  if (!/GNU Lesser General Public\s+License/i.test(license) || /nonfree parts compiled|--enable-gpl/i.test(license)) {
    throw new Error(`${file} is not the reviewed LGPL-only decoder binary.`)
  }
}
console.log(`[check:ffmpeg] OK — ${key} (${actual.slice(0, 12)}…)`)
