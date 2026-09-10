import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO = join(__dirname, '..')
const GATE = join(REPO, 'scripts', 'check-test-types.mjs')
const TRACKED_TEST = fileURLToPath(import.meta.url)

function runGate(gate = GATE, cwd = REPO): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(process.execPath, [gate], { encoding: 'utf8', stdio: 'pipe', cwd }) }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

function configPath(from: string, to: string): string {
  const path = relative(from, to)
  const normalized = path.split(sep).join('/')
  // path.relative returns an absolute drive path when the fixture and checkout are on different
  // Windows drives. Prefixing that with './' would corrupt an otherwise valid TypeScript path.
  if (isAbsolute(path)) return normalized
  return normalized.startsWith('.') ? normalized : `./${normalized}`
}

function createFixture(): { root: string; gate: string; invalidProbe: string } {
  // macOS exposes /var as a symlink to /private/var. Resolve it before calculating relative config
  // paths so TypeScript never turns a valid /Users path into the nonexistent /private/Users path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'metis-test-types-ratchet-')))
  const scripts = join(root, 'scripts')
  const fixtureNodeModules = join(root, 'node_modules')
  mkdirSync(scripts, { recursive: true })

  const gate = join(scripts, 'check-test-types.mjs')
  copyFileSync(GATE, gate)
  symlinkSync(
    join(REPO, 'node_modules'),
    fixtureNodeModules,
    process.platform === 'win32' ? 'junction' : 'dir',
  )

  const realConfig = JSON.parse(readFileSync(join(REPO, 'tsconfig.tests.json'), 'utf8')) as {
    include: string[]
  }
  const include = realConfig.include.map((pattern) =>
    configPath(root, join(REPO, ...pattern.split('/'))),
  )
  include.push('./probe-*.ts')
  writeFileSync(join(root, 'tsconfig.tests.json'), JSON.stringify({
    extends: configPath(root, join(REPO, 'tsconfig.tests.json')),
    include,
    exclude: [],
  }, null, 2))
  writeFileSync(join(root, 'probe-valid.ts'), 'export {}\nconst ratchetProbe: number = 1\nvoid ratchetProbe\n')

  return { root, gate, invalidProbe: join(root, 'probe-invalid.ts') }
}

/**
 * MQA-248 — test files were never typechecked, and that is not a cosmetic gap.
 *
 * Both tsconfigs carry `"exclude": ["**\/*.test.ts", ...]`, so a test calling production code with a shape
 * that no longer exists compiles to nothing and reports nothing. That is exactly how `-c undefined` reached
 * a tagged release, and the identical omission was still present twenty times in
 * local-runtime.concurrency.test.ts when this gate was written — invisible there for a second reason too:
 * those tests mock the spawn, so no runtime ever read the bad value.
 *
 * The gate is a ratchet rather than a zero-tolerance check, because ~139 of the remaining errors are vitest
 * mock-typing noise with no defect behind them. A gate that blocks the build on churn gets switched off,
 * and a gate that is switched off protects nothing.
 */
describe('MQA-248 — the test-file typecheck ratchet', () => {
  it('passes at the current baseline', () => {
    const r = runGate()
    expect(r.out).toMatch(/at the baseline/)
    expect(r.code).toBe(0)
  })

  it('FAILS when a new type error appears — the whole point', () => {
    // Exercise an exact copy of the real gate against the real project errors plus an isolated probe.
    // The tracked test file stays immutable, so parallel typechecks can never observe the extra error.
    const trackedBefore = readFileSync(TRACKED_TEST, 'utf8')
    const fixture = createFixture()
    try {
      expect(readFileSync(fixture.gate, 'utf8')).toBe(readFileSync(GATE, 'utf8'))
      const baseline = runGate(fixture.gate, fixture.root)
      expect(baseline.code, baseline.out).toBe(0)
      const baselineMatch = baseline.out.match(/OK — (\d+) known type errors.+at the baseline/)
      expect(baselineMatch).not.toBeNull()
      const baselineCount = Number(baselineMatch?.[1])
      expect(readFileSync(TRACKED_TEST, 'utf8')).toBe(trackedBefore)

      writeFileSync(fixture.invalidProbe, 'export {}\nconst ratchetProbe: number = "not a number"\nvoid ratchetProbe\n')
      const increased = runGate(fixture.gate, fixture.root)
      expect(increased.code, increased.out).toBe(1)
      expect(increased.out).toContain(
        `${baselineCount + 1} type errors in test files, up from the ${baselineCount} baseline`,
      )
      expect(readFileSync(TRACKED_TEST, 'utf8')).toBe(trackedBefore)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
    expect(readFileSync(TRACKED_TEST, 'utf8')).toBe(trackedBefore)
  })

  it('also fails when the baseline is STALE — a fixed error must lower it', () => {
    // The asymmetric half people forget. If the count drops and the baseline does not, the gap silently
    // becomes headroom for new errors. So dropping below is a failure too, with the new number in the
    // message ready to paste.
    const src = readFileSync(GATE, 'utf8')
    expect(src).toMatch(/count < BASELINE/)
    expect(src).toMatch(/Set BASELINE = \$\{count\}/)
  })

  it('runs as part of `npm run typecheck`, not as a thing to remember', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts.typecheck).toContain('scripts/check-test-types.mjs')
    expect(pkg.scripts['typecheck:tests']).toBe('node scripts/check-test-types.mjs')
  })

  it('the config it checks does NOT exclude test files — otherwise it measures nothing', () => {
    // The failure mode that would make this whole gate a no-op while still printing OK.
    const cfg = JSON.parse(readFileSync(join(REPO, 'tsconfig.tests.json'), 'utf8')) as { exclude?: string[] }
    expect(cfg.exclude ?? []).toEqual([])
  })
})
