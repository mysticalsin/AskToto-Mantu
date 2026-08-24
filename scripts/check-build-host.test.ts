import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = join(__dirname, '..')
const SCRIPT = join(REPO, 'scripts', 'check-build-host.mjs')
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

function run(target: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, target], { encoding: 'utf8', stdio: 'pipe' })
    return { code: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

describe('check-build-host — the .exe may only be built where it can be launched', () => {
  it('passes for the host platform and refuses a foreign one', () => {
    // The Windows chain EXECUTES what it builds (packaged launch + a real Parakeet decode), so a host
    // that cannot run the artefact must not be able to produce it — an installer nobody launched is how
    // a DOA build ships.
    const own = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'
    const foreign = own === 'win' ? 'mac' : 'win'

    expect(run(own).code).toBe(0)
    const refused = run(foreign)
    expect(refused.code).toBe(1)
    expect(refused.out).toMatch(/REFUSED/)
  })

  it('rejects an unknown target rather than silently allowing the build', () => {
    const r = run('solaris')
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/unknown target/i)
  })

  it('guards EVERY Windows packaging entry point, as its first step', () => {
    // First in the chain on purpose: the point is to fail in seconds with a clear reason, not several
    // minutes in when a downstream gate trips over a binary it cannot execute.
    for (const name of ['predist:win', 'dist:win', 'release:build:win']) {
      const script = pkg.scripts[name]
      expect(script, `${name} must exist`).toBeTruthy()
      expect(script.startsWith('node scripts/check-build-host.mjs win'), `${name} must lead with the host guard`).toBe(true)
    }
  })

  it('offers no override flag — an escape hatch would be used exactly once, in a hurry', () => {
    const src = readFileSync(SCRIPT, 'utf8')
    expect(src).not.toMatch(/FORCE|SKIP_|--force|allowCrossBuild/i)
  })
})
