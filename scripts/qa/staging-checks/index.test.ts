import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHECKS,
  CHECK_SECRETS,
  DEPLOY_SECRET,
  ENVIRONMENT,
  bundleDigest,
  checkEntry,
  checkEnv,
  deployReceipt,
  deployRunCandidates,
  laneRecord,
  scanUploads,
  stagingUrl
} from './index.mjs'

const INDEX = join(__dirname, 'index.mjs')
const COMMIT = 'abcdef1234567890abcdef1234567890abcdef12'
const ciEnv = { GITHUB_SHA: COMMIT, GITHUB_RUN_ID: '9001' }
const receipt = { version: 'abcdef1', deploy_run_id: 8000, commit: COMMIT, bundle_sha256: 'b'.repeat(64) }
const argv = ['scripts/qa/staging-checks/index.mjs', 'exec', '--check', 'health', '--expected-version', 'abcdef1', '--out', 'operator-staging-check']

describe('the check registry', () => {
  it('ships health for M2-0103 and gateway-privacy for M2-0104', () => {
    expect(Object.keys(CHECKS)).toEqual(['health', 'gateway-privacy'])
    expect(CHECKS.health.ticket).toBe('M2-0103')
    expect(CHECKS['gateway-privacy'].ticket).toBe('M2-0104')
  })

  it('refuses a check that is not registered, including inherited object keys', () => {
    for (const name of ['nope', '', 'constructor', '__proto__', 'Health']) {
      expect(() => checkEntry(name)).toThrow(/is not a registered staging check \(health, gateway-privacy\)/)
    }
  })

  it('the guard CLI exits non-zero on an unknown check and zero on a registered one', () => {
    let status = 0
    let stderr = ''
    try {
      execFileSync(process.execPath, [INDEX, 'guard', '--check', 'drop-tables'], { encoding: 'utf8', stdio: 'pipe' })
    } catch (error) {
      status = (error as { status: number }).status
      stderr = String((error as { stderr: string }).stderr)
    }
    expect(status).toBe(1)
    expect(stderr).toContain('"drop-tables" is not a registered staging check')
    expect(execFileSync(process.execPath, [INDEX, 'guard', '--check', 'health'], { encoding: 'utf8' })).toContain('health is a registered staging check')
  })

  it('every check declares only secrets the workflow maps, and the deploy token is never one of them', () => {
    expect(CHECK_SECRETS).not.toContain(DEPLOY_SECRET)
    for (const [name, entry] of Object.entries(CHECKS)) {
      expect(entry.secrets.every((secret: string) => CHECK_SECRETS.includes(secret)), name).toBe(true)
    }
  })
})

describe('checkEnv', () => {
  const env = {
    PATH: '/usr/bin',
    STAGING_URL: 'https://staging.invalid',
    [DEPLOY_SECRET]: 'deploy-token',
    CLOUDFLARE_API_TOKEN: 'deploy-token',
    OPERATOR_STAGING_GATEWAY_READ_TOKEN: 'gateway-token',
    OPERATOR_STAGING_TEST_DEVICE_CREDENTIAL: 'device-credential'
  }

  it('gives a check only the secrets its registry entry declares', () => {
    const gateway = checkEnv('gateway-privacy', env)
    expect(gateway.OPERATOR_STAGING_GATEWAY_READ_TOKEN).toBe('gateway-token')
    expect(gateway).not.toHaveProperty('OPERATOR_STAGING_TEST_DEVICE_CREDENTIAL')
    expect(gateway).not.toHaveProperty(DEPLOY_SECRET)
    expect(gateway).not.toHaveProperty('CLOUDFLARE_API_TOKEN')
    expect(gateway.PATH).toBe('/usr/bin')
    expect(gateway.STAGING_URL).toBe('https://staging.invalid')

    const health = checkEnv('health', env)
    for (const secret of [DEPLOY_SECRET, 'CLOUDFLARE_API_TOKEN', ...CHECK_SECRETS]) expect(health).not.toHaveProperty(secret)
    expect(Object.values(health)).not.toContain('gateway-token')
  })

  it('does not change the caller environment, and refuses an unknown check', () => {
    checkEnv('health', env)
    expect(env.OPERATOR_STAGING_GATEWAY_READ_TOKEN).toBe('gateway-token')
    expect(() => checkEnv('nope', env)).toThrow(/not a registered staging check/)
  })
})

describe('stagingUrl', () => {
  it('takes an https origin from the environment and refuses anything else', () => {
    expect(stagingUrl({ STAGING_URL: 'https://staging.invalid/' })).toBe('https://staging.invalid')
    for (const value of [undefined, '', 'http://staging.invalid', 'https://staging.invalid/health', 'staging']) {
      expect(() => stagingUrl({ STAGING_URL: value })).toThrow(/STAGING_URL/)
    }
  })
})

describe('lane.json', () => {
  const base = { check: 'health', env: ciEnv, argv, exitCode: 0, reportSha256: 'c'.repeat(64), detail: '' }

  it('carries the evidence-record fields and binds the deploy run that produced the served version', () => {
    const lane = laneRecord({ ...base, deployedVersion: 'abcdef1', deployRunId: '8000', receipt })
    expect(lane).toMatchObject({
      check: 'health',
      ticket: 'M2-0103',
      commit: COMMIT,
      ci_run_id: 9001,
      environment: { kind: 'deployed-service', host: 'operator-staging' },
      command: `node ${argv.join(' ')}`,
      exit_code: 0,
      outcome: 'PASS',
      report: { path: 'report.json', sha256: 'c'.repeat(64) },
      deployed_version: 'abcdef1',
      deployment: { run_id: 8000, commit: COMMIT, version: 'abcdef1', bundle_sha256: 'b'.repeat(64) },
      live_verified_eligible: true
    })
    expect(lane.environment).toEqual(ENVIRONMENT)
  })

  it('says deployment unknown when no deploy run produced the served version, and is then not LIVE_VERIFIED evidence', () => {
    const cases = [
      [{ deployedVersion: 'abcdef1', deployRunId: '', receipt: null }, 'no deploy run of operator-staging.yml produced version abcdef1'],
      [{ deployedVersion: '1234567', deployRunId: '8000', receipt }, 'deploy run 8000 produced version abcdef1, staging serves 1234567'],
      [{ deployedVersion: 'abcdef1', deployRunId: '8001', receipt }, 'deploy run 8001 produced version abcdef1, staging serves abcdef1'],
      [{ deployedVersion: '', deployRunId: '8000', receipt }, 'the staging /health reported no version']
    ] as const
    for (const [deployment, detail] of cases) {
      const lane = laneRecord({ ...base, ...deployment })
      expect(lane.deployment).toBe('unknown')
      expect(lane.deployment_detail).toBe(detail)
      expect(lane.live_verified_eligible).toBe(false)
      expect(lane.commit).toBe(COMMIT)
      expect(lane.ci_run_id).toBe(9001)
      expect(lane.environment).toEqual(ENVIRONMENT)
    }
  })

  it('a failing check or a missing report is a FAIL with its exit code', () => {
    const failed = laneRecord({ ...base, exitCode: 1, detail: 'smoke failed', deployedVersion: 'abcdef1', deployRunId: '8000', receipt })
    expect(failed).toMatchObject({ outcome: 'FAIL', exit_code: 1, detail: 'smoke failed', live_verified_eligible: false })
    const noReport = laneRecord({ ...base, reportSha256: null, deployedVersion: 'abcdef1', deployRunId: '8000', receipt })
    expect(noReport).toMatchObject({ outcome: 'FAIL', report: null })
  })
})

describe('deploy runs and receipts', () => {
  const run = (id: number, head_sha: string, created_at: string, extra = {}) => ({
    id,
    head_sha,
    created_at,
    status: 'completed',
    event: 'workflow_dispatch',
    head_branch: 'main',
    ...extra
  })

  it('lists main dispatch runs of the served commit, newest first', () => {
    const runs = {
      workflow_runs: [
        run(1, COMMIT, '2026-10-01T00:00:00Z'),
        run(3, COMMIT, '2026-10-03T00:00:00Z'),
        run(2, 'ffff'.repeat(10), '2026-10-02T00:00:00Z'),
        run(4, COMMIT, '2026-10-04T00:00:00Z', { head_branch: 'feature' }),
        run(5, COMMIT, '2026-10-05T00:00:00Z', { event: 'pull_request' }),
        run(6, COMMIT, '2026-10-06T00:00:00Z', { status: 'in_progress' })
      ]
    }
    expect(deployRunCandidates(runs, 'abcdef1')).toEqual([3, 1])
    expect(deployRunCandidates(runs, '')).toEqual([])
    expect(deployRunCandidates(runs, '<set by deploy>')).toEqual([])
  })

  it('hashes every file wrangler wrote and refuses an empty bundle directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'staging-bundle-'))
    expect(() => bundleDigest(dir)).toThrow(/wrote no bundle/)
    writeFileSync(join(dir, 'index.js'), 'export default {}')
    const one = bundleDigest(dir)
    expect(one.files.map((file: { path: string }) => file.path)).toEqual(['index.js'])
    expect(one.sha256).toMatch(/^[0-9a-f]{64}$/)
    writeFileSync(join(dir, 'index.js'), 'export default { changed: true }')
    expect(bundleDigest(dir).sha256).not.toBe(one.sha256)
  })

  it('writes a receipt only for the staging Worker and this run commit', () => {
    const bundle = { sha256: 'b'.repeat(64), files: [{ path: 'index.js', sha256: 'd'.repeat(64) }] }
    const staging = { worker: 'metis-operator-staging', database: 'metis-operator-staging' }
    expect(deployReceipt({ env: ciEnv, version: 'abcdef1', bundle, target: staging })).toEqual({
      schema: 1,
      environment: 'staging',
      worker: 'metis-operator-staging',
      database: 'metis-operator-staging',
      commit: COMMIT,
      version: 'abcdef1',
      deploy_run_id: 9001,
      bundle_sha256: 'b'.repeat(64),
      bundle_files: bundle.files
    })
    expect(() => deployReceipt({ env: ciEnv, version: 'abcdef1', bundle, target: { worker: 'metis-operator', database: 'metis-operator' } })).toThrow(
      /not metis-operator-staging/
    )
    expect(() => deployReceipt({ env: ciEnv, version: '1234567', bundle, target: staging })).toThrow(/not the short sha/)
  })
})

describe('the content-free gate', () => {
  it('removes a file naming the staging host, an account id, a workers.dev host, a token header or a home path, and keeps a clean lane', () => {
    const dir = mkdtempSync(join(tmpdir(), 'staging-upload-'))
    mkdirSync(join(dir, 'nested'))
    const files = {
      'lane.json': JSON.stringify(laneRecord({ check: 'health', env: ciEnv, argv, exitCode: 0, reportSha256: 'c'.repeat(64), detail: '', deployedVersion: 'abcdef1', deployRunId: '8000', receipt })),
      'host.json': '{"url":"https://staging.example.invalid"}',
      'account.json': `{"account":"${'0123456789abcdef'.repeat(2)}"}`,
      'workers.json': '{"url":"https://metis-operator-staging.someone.workers.dev"}',
      'nested/token.txt': 'authorization: Bearer abc123',
      'home.txt': '/home/runner-person/x'
    }
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
    const problems = scanUploads(dir, { account: 'runner', host: 'staging.example.invalid' })
    expect(problems.sort()).toEqual(
      ['account.json: account id', 'home.txt: Linux user home path', 'host.json: staging host', 'token.txt: authorization header', 'workers.json: workers.dev host'].sort()
    )
    expect(existsSync(join(dir, 'lane.json'))).toBe(true)
    for (const name of Object.keys(files).filter((name) => name !== 'lane.json')) expect(existsSync(join(dir, name))).toBe(false)
  })
})
