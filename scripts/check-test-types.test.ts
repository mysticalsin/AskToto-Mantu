import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = join(__dirname, '..')
const GATE = join(REPO, 'scripts', 'check-test-types.mjs')

function runGate(): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(process.execPath, [GATE], { encoding: 'utf8', stdio: 'pipe', cwd: REPO }) }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
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
    // Proven by introducing one, not by trusting the arithmetic. A gate nobody has watched fail is a
    // gate nobody knows works.
    const victim = join(REPO, 'scripts', 'check-test-types.test.ts')
    const original = readFileSync(victim, 'utf8')
    try {
      appendFileSync(victim, '\nconst __ratchetProbe: number = "not a number"\nvoid __ratchetProbe\n')
      const r = runGate()
      expect(r.code).toBe(1)
      expect(r.out).toMatch(/up from the \d+ baseline/)
    } finally {
      writeFileSync(victim, original)
    }
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
