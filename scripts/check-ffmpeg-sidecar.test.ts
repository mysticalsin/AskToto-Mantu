/**
 * check-ffmpeg-sidecar.mjs — the licence gate must not blame the licence for a binary it
 * never managed to run.
 *
 * The sha256 comparison happens before the banner check, so by the time the script spawns
 * `ffmpeg -L` it has already proved the file is the reviewed one. An unreported spawn failure
 * used to leave the banner empty, fail the LGPL regex, and report "is not the reviewed
 * LGPL-only decoder binary" — sending whoever read the CI log after a licensing problem that
 * did not exist. That is what these tests lock.
 *
 * The fixture is built for the HOST platform/arch on purpose: the script only spawns the
 * binary when the requested target matches the host, so hard-coding darwin/arm64 would make
 * every case silently skip the branch under test on a Linux CI runner.
 *
 * Fixture portability: on POSIX a `#!/bin/sh` file IS an executable — execve honours the
 * shebang, so a two-line script can impersonate ffmpeg and print whatever banner a case
 * needs. Windows has no equivalent: CreateProcess only loads a real PE image, so a shell
 * script (or a .bat) written as `ffmpeg.exe` fails to spawn with UNKNOWN before it can
 * print anything. The two cases that need a SPECIFIC banner therefore cannot run on
 * Windows without shipping a compiled PE fixture, and are pinned to POSIX below. The
 * cases that only need a real host binary to misbehave do run everywhere.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(__dirname, 'check-ffmpeg-sidecar.mjs')
const platform = process.platform
const arch = process.arch
const isWindows = platform === 'win32'
// On a darwin host the script's target defaults to the host, so the portability gate rejects these
// fixtures as "not a Mach-O image" before reaching the spawn they exist to exercise — a fixture
// cannot be both a `#!/bin/sh` script (needed to control the banner, or to force a spawn failure)
// and a Mach-O image. Linux CI keeps the coverage. Do NOT "fix" this by narrowing the gate to
// `target === 'mac'`: that would disable the portability check for the host-target run, which is the
// invocation most likely to catch a bad rebuild on the maintainer's own Mac.
const isMac = platform === 'darwin'
// Where the mac target IS the host, the gate goes on to spawn the binary. The synthetic Mach-O
// fixtures below are headers with no segment, no entry point and no signature, so macOS cannot load
// them — a fixture limitation, not a gate defect.
const macTargetIsHost = platform === 'darwin' && arch === 'arm64'
const binaryName = isWindows ? 'ffmpeg.exe' : 'ffmpeg'
const key = `${platform}-${arch}/${binaryName}`

let cwd: string

/** Lay down resources/ffmpeg/<platform>-<arch>/<binary> plus a manifest pinning its real hash. */
function seed(content: string | Buffer): void {
  const dir = join(cwd, 'resources', 'ffmpeg', `${platform}-${arch}`)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, binaryName)
  writeFileSync(file, content, { mode: 0o755 })
  const sha256 = createHash('sha256').update(content).digest('hex')
  writeFileSync(
    join(cwd, 'resources', 'ffmpeg', 'manifest.json'),
    JSON.stringify({ binaries: { [key]: { sha256 } } })
  )
}

/**
 * Seed a genuine host-native executable that exits non-zero on `-L` without printing a
 * licence banner, and return the exit code it really produces. Used where a shebang
 * script cannot be loaded (Windows). The node binary running this test is by definition a
 * valid image for this host, and rejects `-L` during argument parsing — before any script
 * or NODE_OPTIONS require would run — so it cannot accidentally emit a banner.
 */
function seedHostBinaryRejectingDashL(): number {
  seed(readFileSync(process.execPath))
  const probe = spawnSync(join(cwd, 'resources', 'ffmpeg', `${platform}-${arch}`, binaryName), ['-L'], {
    encoding: 'utf8'
  })
  // Guard the premise: if this ever spawns cleanly or exits 0, the case below is vacuous.
  expect(probe.error).toBeUndefined()
  expect(probe.status).not.toBe(0)
  return probe.status as number
}

function run(args: string[] = []): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' })
  return { status: r.status, output: `${r.stdout || ''}\n${r.stderr || ''}` }
}

/**
 * Seed resources/ffmpeg/darwin-arm64/ffmpeg. Checking the macOS target from any host is the point:
 * on every host EXCEPT darwin/arm64 the script skips the spawn, so these cases exercise the
 * portability gate alone on Linux and Windows CI. On darwin/arm64 the target IS the host, so the
 * gate proceeds to the spawn and the synthetic header cannot be loaded — there the accept case can
 * only assert that the portability gate stayed silent. The end-to-end accept path is covered by the
 * gate running against the real sidecar during predist.
 */
function seedMac(content: Buffer): void {
  const dir = join(cwd, 'resources', 'ffmpeg', 'darwin-arm64')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'ffmpeg'), content, { mode: 0o755 })
  writeFileSync(
    join(cwd, 'resources', 'ffmpeg', 'manifest.json'),
    JSON.stringify({
      binaries: { 'darwin-arm64/ffmpeg': { sha256: createHash('sha256').update(content).digest('hex') } }
    })
  )
}

/** Pin a manifest entry for a binary that is NOT on disk — the fresh-clone / cold-runner case. */
function seedManifestOnly(key: string): void {
  mkdirSync(join(cwd, 'resources', 'ffmpeg'), { recursive: true })
  writeFileSync(
    join(cwd, 'resources', 'ffmpeg', 'manifest.json'),
    JSON.stringify({ binaries: { [key]: { sha256: 'f'.repeat(64) } } })
  )
}

/** A little-endian 64-bit Mach-O executable that declares the given dylib dependencies. */
function machoWithDylibs(names: string[]): Buffer {
  const commands = names.map((name) => {
    const nameBytes = Buffer.from(`${name}\0`, 'utf8')
    const size = Math.ceil((24 + nameBytes.length) / 8) * 8
    const command = Buffer.alloc(size)
    command.writeUInt32LE(0x0000000c, 0) // LC_LOAD_DYLIB
    command.writeUInt32LE(size, 4)
    command.writeUInt32LE(24, 8) // name offset
    nameBytes.copy(command, 24)
    return command
  })
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf, 0) // MH_MAGIC_64
  header.writeUInt32LE(0x0100000c, 4) // CPU_TYPE_ARM64
  header.writeUInt32LE(2, 12) // MH_EXECUTE
  header.writeUInt32LE(commands.length, 16)
  header.writeUInt32LE(
    commands.reduce((total, c) => total + c.length, 0),
    20
  )
  return Buffer.concat([header, ...commands])
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ffmpeg-sidecar-check-'))
})
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('check-ffmpeg-sidecar licence gate', () => {
  // POSIX-only: asserting on banner CONTENT needs a fixture that prints a chosen string,
  // which on this host means a `#!/bin/sh` script. Windows cannot express that — see the
  // file header — and stock PE binaries print their own text, never an FFmpeg banner.
  it.skipIf(isWindows || isMac)('accepts a binary whose banner reports the LGPL', () => {
    seed('#!/bin/sh\necho "GNU Lesser General Public License version 2.1"\n')
    const { status, output } = run()
    expect(output).toContain('[check:ffmpeg] OK')
    expect(status).toBe(0)
  })

  // POSIX-only for the same reason as above: the fixture must emit `--enable-gpl`.
  it.skipIf(isWindows || isMac)('rejects a binary built with GPL/nonfree parts', () => {
    seed('#!/bin/sh\necho "GNU Lesser General Public License --enable-gpl"\n')
    const { status, output } = run()
    expect(output).toContain('is not the reviewed LGPL-only decoder binary')
    expect(status).not.toBe(0)
  })

  it.skipIf(isMac)('reports an unexecutable binary as an execution failure, not a licence failure', () => {
    // A shebang naming an interpreter that does not exist. Getting this to fail the SAME way on all
    // three hosts is fiddlier than it looks:
    //   - a raw non-image payload is not enough on Linux, because execvp() falls back to /bin/sh when
    //     execve returns ENOEXEC, so dash interprets the bytes and the gate sees a normal exit 127
    //     ("1: ^A^B: not found"). That is what failed every ubuntu CI run on main.
    //   - dropping the execute bit does not work either: the gate's own exec-bit guard in
    //     check-ffmpeg-sidecar.mjs throws "is not executable" before it ever spawns.
    // A missing interpreter makes execve return ENOENT, which has no shell fallback, so POSIX reports a
    // real spawn error; Windows rejects the non-PE payload anyway (UNKNOWN). Same branch on all three.
    seed('#!/nonexistent-interpreter-for-this-test\n')
    const { status, output } = run()
    expect(status).not.toBe(0)
    expect(output).toContain('could not be executed')
    expect(output).toContain('This is not a licensing failure')
    // The whole point: it must NOT report the old misleading message.
    expect(output).not.toContain('is not the reviewed LGPL-only decoder binary')
  })

  it.skipIf(isMac)('reports a non-zero exit as an execution failure, not a licence failure', () => {
    // Runs on every host: this case only needs a real executable that exits non-zero
    // without a banner, which Windows CAN supply (unlike the two banner cases above).
    let expectedExit = 3
    if (isWindows) {
      expectedExit = seedHostBinaryRejectingDashL()
    } else {
      seed('#!/bin/sh\necho "boom" >&2\nexit 3\n')
    }
    const { status, output } = run()
    expect(status).not.toBe(0)
    expect(output).toContain(`exited ${expectedExit}`)
    expect(output).toContain('This is not a licensing failure')
    expect(output).not.toContain('is not the reviewed LGPL-only decoder binary')
  })

  // The macOS sidecar shipped linking /opt/homebrew/opt/sdl2/lib/libSDL2-2.0.0.dylib: correct bytes,
  // correct hash, and dyld killed it on every machine that was not the one that built it. In CI it
  // aborted before printing its banner, so the gate could only say the licence could not be read.
  // These cases make the gate name the real defect, and do it from any host.
  it('rejects a macOS binary that links non-system libraries', () => {
    seedMac(
      machoWithDylibs(['/usr/lib/libSystem.B.dylib', '/opt/homebrew/opt/sdl2/lib/libSDL2-2.0.0.dylib'])
    )
    const { status, output } = run(['mac', 'arm64'])
    expect(status).not.toBe(0)
    expect(output).toContain('/opt/homebrew/opt/sdl2/lib/libSDL2-2.0.0.dylib')
    expect(output).toContain('clean macOS install does not have')
    expect(output).toContain('This is not a licensing failure')
    expect(output).not.toContain('is not the reviewed LGPL-only decoder binary')
  })

  it('accepts a macOS binary that only links system libraries', () => {
    seedMac(
      machoWithDylibs([
        '/usr/lib/libSystem.B.dylib',
        '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'
      ])
    )
    const { status, output } = run(['mac', 'arm64'])
    // What this case locks is that the portability gate does NOT fire for system-only dylibs.
    // That holds on every host.
    expect(output).not.toContain('clean macOS install does not have')
    expect(output).not.toContain('is not a Mach-O image')
    if (macTargetIsHost) {
      // Here the gate goes on to spawn the fixture, and macOS refuses to load a header with no
      // segment or entry point. That is the fixture's limit, not the gate's, so the only claim
      // left is that the failure was reported as an execution problem rather than a licence one.
      expect(output).toContain('This is not a licensing failure')
    } else {
      expect(output).toContain('[check:ffmpeg] OK')
      expect(status).toBe(0)
    }
  })

  it('rejects a macOS sidecar that is not a Mach-O image', () => {
    // Provisioning downloads this from a release asset; a stray HTML error page or a Windows build
    // uploaded under the wrong name would otherwise only surface as a launch crash.
    seedMac(Buffer.from('MZ\x90\x00 this is a PE image, not a Mach-O one'))
    const { status, output } = run(['mac', 'arm64'])
    expect(status).not.toBe(0)
    expect(output).toContain('is not a Mach-O image')
  })

  // A binary that is simply ABSENT is the common case on a fresh clone and on a cold CI runner: the
  // reviewed sidecars are untracked by design, so `npm run dist` opens with a check for a file git has
  // never carried. Until MQA-206 that check was a bare `statSync`, so the whole mac chain died on
  // `ENOENT: no such file or directory, stat 'resources/ffmpeg/darwin-x64/ffmpeg'` — a path the person
  // reading it has never heard of, with no hint that the fix is a release download. The gate must name
  // the release and the command, the way build.yml's hard gate already does for the runner.
  it('tells a mac operator where a MISSING sidecar comes from instead of throwing a raw ENOENT', () => {
    seedManifestOnly('darwin-arm64/ffmpeg')
    const { status, output } = run(['mac', 'arm64'])
    expect(status).not.toBe(0)
    expect(output).toContain('resources/ffmpeg/darwin-arm64/ffmpeg')
    expect(output).toContain('ffmpeg-sidecar-v1')
    expect(output).toContain('ffmpeg-darwin-arm64')
    expect(output).toContain('gh release download')
    expect(output).toContain('docs/ENTERPRISE_RELEASE.md')
    // The raw stat failure is what this replaced; leaking it back means the remedy went with it.
    expect(output).not.toContain('ENOENT')
  })

  it('names the .exe asset when the missing sidecar is the Windows one', () => {
    seedManifestOnly('win32-x64/ffmpeg.exe')
    const { status, output } = run(['win', 'x64'])
    expect(status).not.toBe(0)
    expect(output).toContain('ffmpeg-win32-x64.exe')
    expect(output).toContain('ffmpeg-sidecar-v1')
    expect(output).not.toContain('ENOENT')
  })

  it('still fails on a hash mismatch before ever running the binary', () => {
    seed('#!/bin/sh\necho "GNU Lesser General Public License"\n')
    // Rewrite the binary so it no longer matches the manifest hash recorded above.
    writeFileSync(join(cwd, 'resources', 'ffmpeg', `${platform}-${arch}`, binaryName), '#!/bin/sh\nexit 0\n', {
      mode: 0o755
    })
    const { status, output } = run()
    expect(status).not.toBe(0)
    expect(output).toContain('hash mismatch')
  })
})
