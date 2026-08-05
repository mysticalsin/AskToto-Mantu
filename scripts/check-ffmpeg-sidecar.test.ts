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

function run(): { status: number | null; output: string } {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' })
  return { status: r.status, output: `${r.stdout || ''}\n${r.stderr || ''}` }
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
  it.skipIf(isWindows)('accepts a binary whose banner reports the LGPL', () => {
    seed('#!/bin/sh\necho "GNU Lesser General Public License version 2.1"\n')
    const { status, output } = run()
    expect(output).toContain('[check:ffmpeg] OK')
    expect(status).toBe(0)
  })

  // POSIX-only for the same reason as above: the fixture must emit `--enable-gpl`.
  it.skipIf(isWindows)('rejects a binary built with GPL/nonfree parts', () => {
    seed('#!/bin/sh\necho "GNU Lesser General Public License --enable-gpl"\n')
    const { status, output } = run()
    expect(output).toContain('is not the reviewed LGPL-only decoder binary')
    expect(status).not.toBe(0)
  })

  it('reports an unexecutable binary as an execution failure, not a licence failure', () => {
    // A shebang naming an interpreter that does not exist. Getting this to fail the SAME way on all
    // three hosts is fiddlier than it looks:
    //   - a raw non-image payload is not enough on Linux, because execvp() falls back to /bin/sh when
    //     execve returns ENOEXEC, so dash interprets the bytes and the gate sees a normal exit 127
    //     ("1: ^A^B: not found"). That is what failed every ubuntu CI run on main.
    //   - dropping the execute bit does not work either: the gate's own exec-bit guard
    //     (check-ffmpeg-sidecar.mjs:18) throws "is not executable" before it ever spawns.
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

  it('reports a non-zero exit as an execution failure, not a licence failure', () => {
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
