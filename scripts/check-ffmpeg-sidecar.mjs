#!/usr/bin/env node
/** Verify the reviewed LGPL FFmpeg import-decoder sidecar before packaging. */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { nonPortableDylibs } from './lib/macho-dylibs.mjs'

const target = process.argv[2] || process.platform
const arch = process.argv[3] || (target === 'win' ? 'x64' : process.arch)
const platform = target === 'win' ? 'win32' : target === 'mac' ? 'darwin' : process.platform
const file = join('resources', 'ffmpeg', `${platform}-${arch}`, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const manifest = JSON.parse(readFileSync(join('resources', 'ffmpeg', 'manifest.json'), 'utf8'))
const key = `${platform}-${arch}/${platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'}`
const expected = manifest.binaries?.[key]?.sha256

if (!expected) throw new Error(`No reviewed FFmpeg manifest entry for ${key}.`)
// The reviewed sidecars are untracked on purpose — only manifest.json and the licence are in git — so
// on a fresh clone and on a cold CI runner this file is simply absent. A bare statSync reported that as
// `ENOENT ... stat 'resources/ffmpeg/darwin-x64/ffmpeg'`, naming a path the operator has never heard of
// at the very first command of `npm run dist`, with no hint that the remedy is a release download. Name
// the release and the command instead, exactly as build.yml's hard gate does for the runner.
if (!existsSync(file)) {
  const asset = `ffmpeg-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`
  // Posix separators throughout: the remedy below is a bash command line (that is what CI and every
  // runbook use), and a Windows-style path pasted into it would not resolve.
  const path = file.split(sep).join('/')
  throw new Error(
    `Missing ${path}. The reviewed FFmpeg sidecars are untracked (git carries only ` +
      `resources/ffmpeg/manifest.json and the licence), so this binary comes from this repo's ` +
      `ffmpeg-sidecar-v1 GitHub release:\n` +
      `  gh release download ffmpeg-sidecar-v1 --pattern '${asset}' --dir resources/ffmpeg --clobber\n` +
      `  mv resources/ffmpeg/${asset} ${path}${platform === 'win32' ? '' : ` && chmod +x ${path}`}\n` +
      `If that release carries no ${asset} asset yet, a maintainer holding the reviewed binary must seed ` +
      `it once — docs/ENTERPRISE_RELEASE.md, "ffmpeg Sidecar Provisioning"` +
      (platform === 'darwin'
        ? `. Build the macOS binary from source with scripts/build-ffmpeg-sidecar-mac.sh ${arch} ` +
          `(docs/MAC_SIDECAR_REBUILD.md); never copy one from a package manager, and re-seeding requires ` +
          `updating the reviewed sha256 in the manifest.`
        : '.')
  )
}
const stat = statSync(file)
// Only the host can answer this. A POSIX execute bit read off a file sitting on NTFS says nothing
// about the file — Windows has no such permission — so cross-checking a macOS sidecar from a Windows
// checkout would fail on a bit that does not exist rather than on anything wrong with the binary.
if (platform === process.platform && process.platform !== 'win32' && !(stat.mode & 0o111)) {
  throw new Error(`${file} is not executable.`)
}
const bytes = readFileSync(file)
const actual = createHash('sha256').update(bytes).digest('hex')
if (actual !== expected) throw new Error(`${file} hash mismatch: expected ${expected}, got ${actual}.`)

// A macOS sidecar must load on a machine that has nothing installed but macOS. A binary built on a
// developer's Mac happily links whatever Homebrew left lying around, keeps working there, and then
// dies with "Library not loaded" on every user's machine — and in CI it aborts before printing its
// licence banner, so the gate below can only report the far less useful "could not read the banner".
// Reading the load commands names the actual defect, and does it from any host, so a non-portable
// binary cannot be seeded into the ffmpeg-sidecar release in the first place.
if (platform === 'darwin') {
  const foreign = nonPortableDylibs(bytes)
  if (foreign === null) {
    throw new Error(`${file} matched the reviewed sha256 but is not a Mach-O image, so it cannot run on macOS.`)
  }
  if (foreign.length > 0) {
    throw new Error(
      `${file} matched the reviewed sha256 but links ${foreign.length} librar${foreign.length === 1 ? 'y' : 'ies'} ` +
        `that a clean macOS install does not have: ${foreign.join(', ')}. This is not a licensing failure — the ` +
        `binary was built against locally installed libraries (Homebrew/MacPorts) and will fail with "Library not ` +
        `loaded" for every user. Rebuild it self-contained with scripts/build-ffmpeg-sidecar-mac.sh, then re-seed ` +
        `the ffmpeg-sidecar release and the manifest sha256 (docs/ENTERPRISE_RELEASE.md → ffmpeg Sidecar Provisioning).`
    )
  }
}
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
