import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO = join(__dirname, '..')
const GATE = join(REPO, 'scripts', 'check-test-types.mjs')
const TRACKED_TEST = fileURLToPath(import.meta.url)
const baselineMatch = readFileSync(GATE, 'utf8').match(/^const BASELINE = (\d+)\s*$/m)
if (!baselineMatch) throw new Error('The real test-type gate must declare its ratchet baseline.')
const BASELINE = Number(baselineMatch[1])
const COMPILER_FAILURE = '[check:test-types] FAIL — compiler execution did not produce a valid typecheck result.'
const DIAGNOSTIC = "probe-invalid.test.ts(2,7): error TS2322: Type 'string' is not assignable to type 'number'."
const STDERR_SENTINEL = 'SYNTHETIC_COMPILER_STDERR_MUST_NOT_ESCAPE'

function runGate(gate: string, cwd: string): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync(process.execPath, [gate], { encoding: 'utf8', stdio: 'pipe', cwd }) }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

function createFixture(
  errorCount = BASELINE,
  compiler: 'real' | 'missing' | { source: string } = 'real'
): { root: string; gate: string; invalidProbe: string } {
  // Resolve macOS's /var alias so compiler diagnostics consistently refer to the same fixture.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'metis-test-types-ratchet-')))
  const scripts = join(root, 'scripts')
  const fixtureNodeModules = join(root, 'node_modules')
  mkdirSync(scripts, { recursive: true })

  const gate = join(scripts, 'check-test-types.mjs')
  copyFileSync(GATE, gate)
  if (compiler === 'real') {
    symlinkSync(join(REPO, 'node_modules'), fixtureNodeModules, process.platform === 'win32' ? 'junction' : 'dir')
  } else if (compiler !== 'missing') {
    const compilerFolder = join(fixtureNodeModules, 'typescript', 'bin')
    mkdirSync(compilerFolder, { recursive: true })
    const compilerPath = join(compilerFolder, 'tsc')
    writeFileSync(compilerPath, compiler.source)
    expect(readFileSync(compilerPath, 'utf8')).toBe(compiler.source)
  } else {
    expect(existsSync(fixtureNodeModules)).toBe(false)
  }

  // Exercise the unchanged gate and real compiler, but not the whole checkout from inside Vitest.
  // The dedicated `npm run typecheck` gate still checks every production and test file once. Repeating
  // it three times here competes with parallel tests and exceeds their timeout on both CI platforms.
  const config = {
    compilerOptions: {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      target: 'ES2022',
      lib: ['ES2022'],
      types: []
    },
    include: ['./*.test.ts'],
    exclude: []
  }
  const configPath = join(root, 'tsconfig.tests.json')
  writeFileSync(configPath, JSON.stringify(config, null, 2))
  expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(config)
  expect(readFileSync(gate, 'utf8')).toBe(readFileSync(GATE, 'utf8'))
  writeFileSync(
    join(root, 'known-errors.test.ts'),
    [
      'export {}',
      ...Array.from({ length: errorCount }, (_, index) => `const knownError${index}: number = "synthetic baseline"`)
    ].join('\n')
  )
  writeFileSync(join(root, 'probe-valid.test.ts'), 'export {}\nconst ratchetProbe: number = 1\nvoid ratchetProbe\n')

  return { root, gate, invalidProbe: join(root, 'probe-invalid.test.ts') }
}

function setSyntheticBaseline(gate: string): void {
  const original = readFileSync(GATE, 'utf8')
  const declaration = /^const BASELINE = \d+$/gm
  expect(original.match(declaration)).toEqual([`const BASELINE = ${BASELINE}`])
  expect(readFileSync(gate, 'utf8')).toBe(original)
  const synthetic = original.replace(declaration, 'const BASELINE = 1')
  writeFileSync(gate, synthetic)
  expect(readFileSync(gate, 'utf8')).toBe(synthetic)
  expect(synthetic.replace(declaration, `const BASELINE = ${BASELINE}`)).toBe(original)
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
 * The historical ratchet has reached zero. Compiler execution failures must not masquerade as zero
 * diagnostics; a positive synthetic baseline keeps the stale-baseline protection exercised too.
 */
describe('MQA-248 — the test-file typecheck ratchet', () => {
  it('keeps the real baseline at zero', () => {
    expect(BASELINE).toBe(0)
  })

  it('passes at the current baseline', () => {
    const fixture = createFixture()
    try {
      const r = runGate(fixture.gate, fixture.root)
      expect(r.out).toContain(`OK — ${BASELINE} known type errors in test files, at the baseline`)
      expect(r.code).toBe(0)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('FAILS when a new type error appears — the whole point', () => {
    // Exercise an exact copy of the real gate against known compiler errors plus an isolated probe.
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
        `${baselineCount + 1} type errors in test files, up from the ${baselineCount} baseline`
      )
      expect(readFileSync(TRACKED_TEST, 'utf8')).toBe(trackedBefore)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
    expect(readFileSync(TRACKED_TEST, 'utf8')).toBe(trackedBefore)
  })

  it('also fails when the baseline is STALE — a fixed error must lower it', () => {
    // A lower diagnostic count must fail too, or a fixed error silently becomes regression headroom.
    const gateBefore = readFileSync(GATE, 'utf8')
    const testBefore = readFileSync(TRACKED_TEST, 'utf8')
    const fixture = createFixture(0)
    try {
      setSyntheticBaseline(fixture.gate)
      const r = runGate(fixture.gate, fixture.root)
      expect(r.code, r.out).toBe(1)
      expect(r.out).toContain('0 type errors, BELOW the 1 baseline')
      expect(r.out).toContain('Set BASELINE = 0')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
      expect(readFileSync(GATE, 'utf8')).toBe(gateBefore)
      expect(readFileSync(TRACKED_TEST, 'utf8')).toBe(testBefore)
    }
  })

  it('fails closed when the compiler is missing without changing shared dependencies', () => {
    const fixture = createFixture(0, 'missing')
    try {
      const r = runGate(fixture.gate, fixture.root)
      expect(r.code, r.out).toBe(1)
      expect(r.out).toContain(COMPILER_FAILURE)
      expect(r.out).not.toContain('[check:test-types] OK')
      expect(r.out).not.toContain('MODULE_NOT_FOUND')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it.each([
    {
      name: 'nonzero exit without diagnostics',
      source: `process.stderr.write(${JSON.stringify(STDERR_SENTINEL)}); process.exitCode = 1\n`,
      positiveBaseline: false
    },
    {
      name: 'unsupported exit with diagnostic-looking output',
      source: `console.log(${JSON.stringify(DIAGNOSTIC)}); process.exitCode = 3\n`,
      positiveBaseline: false
    },
    {
      name: 'successful exit with diagnostics at a matching synthetic baseline',
      source: `console.log(${JSON.stringify(DIAGNOSTIC)}); process.exitCode = 0\n`,
      positiveBaseline: true
    },
    {
      name: 'interrupted compiler',
      source: "process.kill(process.pid, 'SIGKILL')\n",
      positiveBaseline: false
    }
  ])('fails closed for $name', ({ source, positiveBaseline }) => {
    const fixture = createFixture(0, { source })
    try {
      if (positiveBaseline) setSyntheticBaseline(fixture.gate)
      const r = runGate(fixture.gate, fixture.root)
      expect(r.code, r.out).toBe(1)
      expect(r.out).toContain(COMPILER_FAILURE)
      expect(r.out).not.toContain('[check:test-types] OK')
      expect(r.out).not.toContain(STDERR_SENTINEL)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it.each([1, 2])('retains count-rise failure for diagnostic exit %i at zero', (status) => {
    const source = `console.log(${JSON.stringify(DIAGNOSTIC)}); process.exitCode = ${status}\n`
    const fixture = createFixture(0, { source })
    try {
      const r = runGate(fixture.gate, fixture.root)
      expect(r.code, r.out).toBe(1)
      expect(r.out).toContain('1 type errors in test files, up from the 0 baseline')
      expect(r.out).not.toContain(COMPILER_FAILURE)
      expect(r.out).not.toContain('[check:test-types] OK')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it.each([1, 2])('retains positive synthetic-baseline semantics for diagnostic exit %i', (status) => {
    const gateBefore = readFileSync(GATE, 'utf8')
    const source = `console.log(${JSON.stringify(DIAGNOSTIC)}); process.exitCode = ${status}\n`
    const fixture = createFixture(0, { source })
    try {
      setSyntheticBaseline(fixture.gate)
      const r = runGate(fixture.gate, fixture.root)
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain('OK — 1 known type errors in test files, at the baseline')
      expect(r.out).not.toContain(COMPILER_FAILURE)
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
      expect(readFileSync(GATE, 'utf8')).toBe(gateBefore)
    }
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
