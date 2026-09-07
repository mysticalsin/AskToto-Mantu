import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEPLOYED_URLS,
  buildDeployArgs,
  buildMigrateArgs,
  buildSmokeArgs,
  extractDeployedUrl,
  formatBuiltAt,
  parseArgs
} from './deploy.mjs'

describe('parseArgs', () => {
  it('defaults to staging, not dry-run, not allow-dirty', () => {
    expect(parseArgs([])).toEqual({ env: 'staging', dryRun: false, allowDirty: false })
  })

  it('reads --env, --dry-run, --allow-dirty', () => {
    const args = parseArgs(['--env', 'production', '--dry-run', '--allow-dirty'])
    expect(args).toEqual({ env: 'production', dryRun: true, allowDirty: true })
  })

  it('rejects an unknown --env rather than silently defaulting', () => {
    expect(() => parseArgs(['--env', 'prod'])).toThrow(/must be "production" or "staging"/)
  })

  it('--help sets help without requiring a valid --env', () => {
    expect(parseArgs(['--help']).help).toBe(true)
  })
})

describe('buildDeployArgs', () => {
  it('production: stamps version and built-at, no --env flag', () => {
    const args = buildDeployArgs({ env: 'production', version: 'abc1234', builtAt: '2026-09-06T00:00:00.000Z' })
    expect(args).toEqual([
      'deploy',
      '--var',
      'OPERATOR_VERSION:abc1234',
      '--var',
      'OPERATOR_BUILT_AT:2026-09-06T00:00:00.000Z',
    ])
  })

  it('staging: appends --env staging after the --var flags', () => {
    const args = buildDeployArgs({ env: 'staging', version: 'abc1234', builtAt: '2026-09-06T00:00:00.000Z' })
    expect(args).toEqual([
      'deploy',
      '--var',
      'OPERATOR_VERSION:abc1234',
      '--var',
      'OPERATOR_BUILT_AT:2026-09-06T00:00:00.000Z',
      '--env',
      'staging'
    ])
  })

  it('never touches TEAM_DOMAIN or any other config var', () => {
    const args = buildDeployArgs({ env: 'production', version: 'x', builtAt: 'y' })
    expect(args.join(' ')).not.toContain('TEAM_DOMAIN')
  })
})

describe('buildMigrateArgs', () => {
  it('production: --remote only', () => {
    expect(buildMigrateArgs({ env: 'production' })).toEqual(['operator/scripts/migrate.mjs', '--remote'])
  })
  it('staging: --remote --env staging', () => {
    expect(buildMigrateArgs({ env: 'staging' })).toEqual([
      'operator/scripts/migrate.mjs',
      '--remote',
      '--env',
      'staging'
    ])
  })
})

describe('buildSmokeArgs', () => {
  it('passes --url through', () => {
    expect(buildSmokeArgs({ url: 'https://example.workers.dev' })).toEqual([
      'operator/scripts/smoke.mjs',
      '--url',
      'https://example.workers.dev'
    ])
  })
})

describe('extractDeployedUrl', () => {
  it('pulls the workers.dev URL out of wrangler deploy stdout', () => {
    const stdout = 'Uploaded metis-operator (1.23 sec)\nDeployed metis-operator triggers\n  https://metis-operator.tony-walteur.workers.dev\nCurrent Version ID: abc'
    expect(extractDeployedUrl(stdout, 'production')).toBe('https://metis-operator.tony-walteur.workers.dev')
  })

  it('strips trailing punctuation picked up from surrounding prose', () => {
    const stdout = 'see https://metis-operator-staging.tony-walteur.workers.dev.'
    expect(extractDeployedUrl(stdout, 'staging')).toBe('https://metis-operator-staging.tony-walteur.workers.dev')
  })

  it('falls back to the known per-environment URL when stdout has none', () => {
    expect(extractDeployedUrl('', 'production')).toBe(DEPLOYED_URLS.production)
    expect(extractDeployedUrl(undefined, 'staging')).toBe(DEPLOYED_URLS.staging)
  })
})

describe('formatBuiltAt', () => {
  it('formats as ISO 8601', () => {
    const iso = formatBuiltAt(new Date('2026-09-06T13:00:00.000Z'))
    expect(iso).toBe('2026-09-06T13:00:00.000Z')
  })
})

describe('DEPLOYED_URLS', () => {
  it('matches the known production and staging workers.dev hosts', () => {
    expect(DEPLOYED_URLS.production).toBe('https://metis-operator.tony-walteur.workers.dev')
    expect(DEPLOYED_URLS.staging).toBe('https://metis-operator-staging.tony-walteur.workers.dev')
  })
})

describe('isMain entry (paths with spaces)', () => {
  it('decodes import.meta.url like migrate.mjs, not file://${argv}', () => {
    const source = readFileSync(new URL('./deploy.mjs', import.meta.url), 'utf8')
    expect(source).toMatch(/fileURLToPath\(import\.meta\.url\) === process\.argv\[1\]/)
    expect(source).not.toContain('import.meta.url === `file://${process.argv[1]}`')
  })

  it('fileURLToPath matches argv on spaced paths; raw file:// interpolation does not', () => {
    const argvPath = '/tmp/Chief of Staff/Apps Source/operator/scripts/deploy.mjs'
    const metaUrl = pathToFileURL(argvPath).href
    expect(metaUrl).toContain('%20')
    expect(metaUrl === `file://${argvPath}`).toBe(false)
    expect(fileURLToPath(metaUrl) === argvPath).toBe(true)
  })
})
