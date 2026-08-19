import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

/**
 * ci-secret-scan.contract.test.ts — MQA-166. The Security job's "Secret scan" is the repo's ONLY
 * committed-credential gate (no husky hook, no gitleaks, no npm script does this), and it was blind to
 * the one credential this product is documented to embed.
 *
 * Two independent holes, both proven before this file existed. (1) Its prefix list was a hand-written
 * literal alternation that never gained `sk-kimi-`, even though that is a first-class shipped format —
 * src/main/cahe-embedded-key.ts defines KIMI_KEY_PATTERN for it, scripts/build-cahe-windows.mjs embeds
 * it into the Cahê installer, and src/shared/providers.ts declares it as a provider keyPattern. So a
 * real sk-kimi- key committed into src/ passed the gate, which then printed "No committed secrets found."
 * (2) Its roots were `src .github electron-builder.yml` and its includes had no `*.mjs`, so scripts/
 * (every build and release script), build/ (where the Cahê key file lives), intelligence/src (a real
 * shipped source tree), and the two overlay packaging configs were never looked at at all.
 *
 * What is asserted. Not the presence of a string: the BEHAVIOUR of the shipped grep — its regex is
 * extracted from build.yml and executed, and its roots/includes are checked against the places this
 * repo actually keeps keys. The prefix expectation is DERIVED from providers.ts rather than re-listed,
 * which is the same move src/shared/redact.ts already made for MQA-080 ("deriving them closes the class
 * instead of the instances"): a provider added later with a new prefix fails this test until the CI
 * gate learns it, so the two lists cannot drift apart again the way they just did.
 *
 * Deliberately no YAML library: js-yaml is only a transitive dependency here, so a test built on it
 * would break on an unrelated lockfile change. The extraction below is targeted and small, matching
 * ci-cost-gates.contract.test.ts and release-gates.test.ts, which read these same files as text.
 */

const root = join(__dirname, '..')
const workflow = readFileSync(join(root, '.github', 'workflows', 'build.yml'), 'utf8').replace(/\r\n/g, '\n')

interface SecretScan {
  pattern: RegExp
  includes: string[]
  excludeFiles: string[]
  excludeDirs: string[]
  roots: string[]
}

/** The shipped `grep` invocation from build.yml's "Secret scan" step, split into its parts. */
function secretScan(): SecretScan {
  const start = workflow.indexOf('if grep -rInE ')
  expect(start, 'build.yml has no `if grep -rInE` secret-scan step').toBeGreaterThan(-1)
  const cmd = workflow.slice(start, workflow.indexOf('; then', start)).replace(/\\\n\s*/g, ' ')
  const pattern = /^if grep -rInE '([^']+)'/.exec(cmd)
  expect(pattern, `could not read the scan regex out of: ${cmd}`).not.toBeNull()
  const all = (re: RegExp): string[] => [...cmd.matchAll(re)].map((m) => m[1])
  return {
    pattern: new RegExp(pattern![1]),
    includes: all(/--include='([^']+)'/g),
    excludeFiles: all(/--exclude='([^']+)'/g),
    excludeDirs: all(/--exclude-dir=(\S+)/g),
    roots: cmd
      .replace(/^if grep -rInE '[^']+'/, '')
      .replace(/--(?:include|exclude)='[^']+'/g, '')
      .replace(/--exclude-dir=\S+/g, '')
      .replace(/2>\/dev\/null/g, '')
      .split(/\s+/)
      .filter(Boolean)
  }
}

/** Every key prefix this app itself claims it can recognise, read from the source that declares them. */
const DECLARED_PREFIXES = [
  ...readFileSync(join(root, 'src', 'shared', 'providers.ts'), 'utf8').matchAll(/keyPattern: '\^([^']+)'/g)
].map((m) => m[1])

/** A 16-character body — the shortest KIMI_KEY_PATTERN accepts, so the gate is tested at its own floor. */
const BODY = 'A1b2C3d4E5f6G7h8'

describe('CI secret scan — must match the key shapes this product itself ships', () => {
  it("MQA-166 — catches this product's own sk-kimi- key, the one credential it embeds", () => {
    const kimiSource = /const KIMI_KEY_PATTERN = \/([^\n/]+)\//.exec(
      readFileSync(join(root, 'src', 'main', 'cahe-embedded-key.ts'), 'utf8')
    )
    expect(kimiSource, 'cahe-embedded-key.ts no longer declares KIMI_KEY_PATTERN').not.toBeNull()
    const key = `sk-kimi-${BODY}`
    // Both sides: the app accepts this string as a key, so CI must refuse to let it be committed.
    expect(new RegExp(kimiSource![1]).test(key)).toBe(true)
    expect(secretScan().pattern.test(key)).toBe(true)
  })

  it('MQA-166 — catches every key prefix declared in providers.ts, not a hand-picked subset', () => {
    expect(DECLARED_PREFIXES.length).toBeGreaterThan(5)
    const { pattern } = secretScan()
    expect(DECLARED_PREFIXES.filter((prefix) => !pattern.test(`${prefix}${BODY}`))).toEqual([])
  })

  it('MQA-166 — does not fire on ordinary dashed words that merely contain sk-', () => {
    // The generic sk- term has to stay word-anchored: without \b, "risk-management-configuration" is a hit.
    const { pattern } = secretScan()
    for (const benign of ['risk-management-configuration-value', 'a task-list-of-sixteen-plus']) {
      expect(pattern.test(benign), `false positive on: ${benign}`).toBe(false)
    }
  })
})

describe('CI secret scan — must look where this product keeps keys', () => {
  it('MQA-166 — scans scripts/, build/ and intelligence/src, not just src/', () => {
    // build/ holds cahe-kimi.local.json; scripts/ holds the packaging chain that reads it; intelligence/
    // is a real source tree shipped as extraResources (electron-builder.yml).
    const { roots } = secretScan()
    for (const dir of ['src', 'scripts', 'build', 'intelligence/src', '.github']) {
      expect(roots, `unscanned root: ${dir}`).toContain(dir)
    }
  })

  it('MQA-166 — scans .mjs, the only extension the build and release scripts use', () => {
    expect(secretScan().includes).toContain('*.mjs')
  })

  it('MQA-166 — scans every packaging config, not only the base electron-builder.yml', () => {
    const { roots } = secretScan()
    for (const file of ['electron-builder.yml', 'electron-builder.win.yml', 'electron-builder.cahe.win.yml']) {
      expect(roots, `unscanned packaging config: ${file}`).toContain(file)
    }
  })
})

/** Basename glob (`*.ts`) to an anchored RegExp. Only `*` is used by the workflow's include/exclude list. */
function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`)
}

/** The files a CI checkout would hand the scan: tracked only, filtered exactly as the flags say. */
function scannedFiles(scan: SecretScan): string[] {
  const git = spawnSync('git', ['ls-files', '-z', '--', ...scan.roots], { cwd: root, encoding: 'utf8' })
  expect(git.status, `git ls-files failed: ${git.stderr}`).toBe(0)
  const includes = scan.includes.map(globToRegExp)
  const excludes = scan.excludeFiles.map(globToRegExp)
  return git.stdout.split('\0').filter((path) => {
    if (!path) return false
    if (path.split('/').some((segment) => scan.excludeDirs.includes(segment))) return false
    const name = path.slice(path.lastIndexOf('/') + 1)
    return includes.some((re) => re.test(name)) && !excludes.some((re) => re.test(name))
  })
}

describe('CI secret scan — must stay green on a clean checkout', () => {
  it('MQA-166 — widening the scan does not turn the Security job red on tracked source', () => {
    // The naive widening does: scripts/qa/*.mjs plant deliberately dead keys (DEAD_NVIDIA, a fake sk-
    // probe) to exercise the degrade path. --exclude='*.test.ts' covers that class for unit tests; the
    // QA harness needs its own carve-out or the first push after this fix fails CI for a non-defect.
    const scan = secretScan()
    const hits: string[] = []
    for (const path of scannedFiles(scan)) {
      readFileSync(join(root, path), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (scan.pattern.test(line)) hits.push(`${path}:${i + 1}`)
        })
    }
    expect(hits).toEqual([])
  })
})
