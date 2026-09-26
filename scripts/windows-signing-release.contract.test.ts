import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * windows-signing-release.contract.test.ts — the `release-windows` job in `.github/workflows/release.yml`
 * wires the mode-aware Windows signing design (see
 * /Users/tony/AI-Brain-build/metis-2.0-exec/tasks/WINDOWS-SIGNING/integration-design.md §2.4/§4) exactly,
 * every release.
 *
 * Deliberately no YAML library: js-yaml is present only as a transitive dependency, so a test built on
 * it would break on an unrelated lockfile change. The extraction below is targeted and small, matching
 * how release-gates.test.ts and ci-cost-gates.contract.test.ts already read these same files.
 *
 * What matters here, and why:
 * - `environment: windows-signing` + exact `permissions` — an OIDC job with the wrong subject or excess
 *   permissions is a supply-chain hole, not a style nit (design §2.4).
 * - The mode gate runs, and every fail-fast probe runs strictly between it and `setup-node`/`npm ci`/the
 *   model cache/the ~1 hour build — the whole point of a "fail fast" gate is that it is actually first.
 * - `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` (the PFX private key material) reach the job only when
 *   `vars.WIN_SIGNING_MODE == 'pfx'` — Cahê still needs the same repo secrets (F19), so they cannot be
 *   deleted, only gated per-expression.
 * - `azure/login` is SHA-pinned, runs exactly twice (probe + immediately before the build), and never
 *   leaves `AZURE_CLIENT_ID`/`AZURE_TENANT_ID`/… as job env — check-packaged-launch.mjs forwards the
 *   whole build env to the launched app, which reads `AZURE_CLIENT_ID` as live SSO config (design F18).
 * - `verify-signing` and `check-update-publisher` both run before the artifact is uploaded.
 */

const root = join(__dirname, '..')
const workflowsDir = join(root, '.github', 'workflows')
const source = readFileSync(join(workflowsDir, 'release.yml'), 'utf8').replace(/\r\n/g, '\n')

/** Slice out one top-level job block, from its own header up to (not including) the next one. */
function jobBlock(text: string, job: string): string {
  const start = text.indexOf(`\n  ${job}:\n`)
  expect(start, `job not found: ${job}`).toBeGreaterThan(-1)
  const rest = text.slice(start + 1)
  const nextJob = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/)
  return nextJob === -1 ? rest : rest.slice(0, nextJob + 1)
}

const job = jobBlock(source, 'release-windows')

/** Index of the first line containing `needle` within `job`, or -1. Used for step ordering. */
function stepIndex(needle: string): number {
  return job.indexOf(needle)
}

describe('release-windows job: OIDC identity and permissions', () => {
  it('runs under the windows-signing environment with exactly contents:read + id-token:write', () => {
    expect(job).toMatch(/\n {4}environment: windows-signing\n/)

    const permStart = job.indexOf('\n    permissions:\n')
    expect(permStart, 'no job-level permissions: block').toBeGreaterThan(-1)
    const afterPerms = job.slice(permStart + '\n    permissions:\n'.length)
    const lines: string[] = []
    for (const line of afterPerms.split('\n')) {
      if (!/^ {6}\S/.test(line)) break
      lines.push(line.trim().replace(/\s*#.*$/, ''))
    }
    const keys = lines.map((line) => line.split(':')[0].trim()).sort()
    expect(keys).toEqual(['contents', 'id-token'])
    expect(lines).toContain('contents: read')
    expect(lines).toContain('id-token: write')
  })

  it('reads the signing mode from the repo/environment variable, never inferring it from secrets', () => {
    expect(job).toMatch(/WIN_SIGNING_MODE:\s*\$\{\{\s*vars\.WIN_SIGNING_MODE\s*\}\}/)
  })
})

describe('release-windows job: fail-closed gate and fail-fast probe ordering', () => {
  it('gates on the mode-aware resolver script, keeping the refusal phrase in the workflow itself', () => {
    expect(job).toContain('run: node scripts/check-release-secrets.mjs win')
    expect(job).toContain('refusing to publish an unsigned Windows release')
  })

  it('runs every fail-fast probe strictly after the gate and before setup-node / npm ci / the build', () => {
    const gate = stepIndex('run: node scripts/check-release-secrets.mjs win')
    const pfxProbe = stepIndex('run: node scripts/windows-signing-identity-preflight.mjs --release-gate')
    const azureModuleInstall = stepIndex('run: node scripts/artifact-signing-module.mjs install')
    const azureProbe = stepIndex('run: node scripts/windows-signing-azure-probe.mjs --release-gate')
    const setupNode = stepIndex('uses: actions/setup-node@')
    const npmCi = stepIndex('run: npm ci')
    const build = stepIndex('run: npm run release:build:win')

    for (const [label, index] of [
      ['gate', gate],
      ['pfx probe', pfxProbe],
      ['azure module install', azureModuleInstall],
      ['azure probe', azureProbe],
      ['setup-node', setupNode],
      ['npm ci', npmCi],
      ['build', build]
    ] as const) {
      expect(index, `step not found: ${label}`).toBeGreaterThan(-1)
    }
    expect(gate).toBeLessThan(pfxProbe)
    expect(gate).toBeLessThan(azureModuleInstall)
    expect(pfxProbe).toBeLessThan(setupNode)
    expect(azureModuleInstall).toBeLessThan(azureProbe)
    expect(azureProbe).toBeLessThan(setupNode)
    expect(setupNode).toBeLessThan(npmCi)
    expect(npmCi).toBeLessThan(build)
  })

  it('every PFX probe/gate/build step guards WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD by mode == pfx', () => {
    const cscLines = [...job.matchAll(/^\s*(WIN_CSC_LINK|WIN_CSC_KEY_PASSWORD):.*$/gm)].map((m) => m[0])
    expect(cscLines.length).toBeGreaterThanOrEqual(6) // gate + pfx probe + build, x2 vars each
    for (const line of cscLines) {
      expect(line, line).toContain(`vars.WIN_SIGNING_MODE == 'pfx' && secrets.`)
      expect(line, line).toMatch(/\|\|\s*''\s*\}\}$/)
    }
    // WIN_CSC_EXPECTED_SUBJECT is required in both modes and must never be pfx-gated away.
    const subjectLines = [...job.matchAll(/^\s*WIN_CSC_EXPECTED_SUBJECT:.*$/gm)].map((m) => m[0])
    expect(subjectLines.length).toBeGreaterThan(0)
    for (const line of subjectLines) expect(line).not.toContain("vars.WIN_SIGNING_MODE == 'pfx'")
  })
})

describe('release-windows job: Azure OIDC never becomes app-visible env', () => {
  it('runs azure/login exactly twice, both SHA-pinned and both gated on mode == azure', () => {
    const uses = [...job.matchAll(/^\s*uses: (azure\/login@.*)$/gm)]
    expect(uses).toHaveLength(2)
    for (const match of uses) {
      expect(match[1]).toMatch(/^azure\/login@[0-9a-f]{40} # v2$/)
      const precedingIf = job.slice(0, match.index).split('\n').slice(-3).join('\n')
      expect(precedingIf).toContain("if: vars.WIN_SIGNING_MODE == 'azure'")
    }
  })

  it('passes azure/login its identity only as action inputs, never as job/step env', () => {
    expect(job).toMatch(/client-id:\s*\$\{\{\s*secrets\.WIN_AZURE_CLIENT_ID\s*\}\}/)
    expect(job).toMatch(/tenant-id:\s*\$\{\{\s*secrets\.WIN_AZURE_TENANT_ID\s*\}\}/)
    expect(job).toMatch(/subscription-id:\s*\$\{\{\s*secrets\.WIN_AZURE_SUBSCRIPTION_ID\s*\}\}/)
    // The env: key form (`AZURE_CLIENT_ID:`) is what check-packaged-launch.mjs would forward to the
    // launched app (design F18); the `client-id:` action-input form above is fine and required.
    expect(job).not.toMatch(/\bAZURE_CLIENT_ID:/)
    expect(job).not.toMatch(/\bAZURE_TENANT_ID:/)
    expect(job).not.toMatch(/\bAZURE_CLIENT_SECRET\b/)
  })

  it('no workflow in this repo ever sets AZURE_CLIENT_SECRET', () => {
    for (const file of readdirSync(workflowsDir).filter((f) => f.endsWith('.yml'))) {
      const text = readFileSync(join(workflowsDir, file), 'utf8')
      expect(text, file).not.toContain('AZURE_CLIENT_SECRET')
    }
  })
})

describe('release-windows job: every action is SHA-pinned', () => {
  it('has no remaining tag-pinned `uses:` reference', () => {
    const uses = [...job.matchAll(/^\s*uses: (\S+)\s*(#.*)?$/gm)].map((m) => m[1])
    expect(uses.length).toBeGreaterThan(0)
    for (const ref of uses) {
      expect(ref, ref).toMatch(/@[0-9a-f]{40}$/)
    }
  })
})

describe('release-windows job: post-build verification order', () => {
  it('runs verify-signing then check-update-publisher, both before upload-artifact', () => {
    const build = stepIndex('run: npm run release:build:win')
    const checkRelease = stepIndex('run: npm run check:release')
    const verifySigning = stepIndex('run: node scripts/verify-signing.mjs')
    const checkUpdatePublisher = stepIndex('run: node scripts/check-update-publisher.mjs release')
    const upload = stepIndex('uses: actions/upload-artifact@')

    for (const [label, index] of [
      ['build', build],
      ['check:release', checkRelease],
      ['verify-signing', verifySigning],
      ['check-update-publisher', checkUpdatePublisher],
      ['upload-artifact', upload]
    ] as const) {
      expect(index, `step not found: ${label}`).toBeGreaterThan(-1)
    }
    expect(build).toBeLessThan(checkRelease)
    expect(checkRelease).toBeLessThan(verifySigning)
    expect(verifySigning).toBeLessThan(checkUpdatePublisher)
    expect(checkUpdatePublisher).toBeLessThan(upload)
  })
})
