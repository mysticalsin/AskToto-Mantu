import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
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
  it('MQA-316 always passes the exact expected build stamp', () => {
    expect(buildSmokeArgs({ url: 'https://example.workers.dev', expectedVersion: 'abc1234' })).toEqual([
      'operator/scripts/smoke.mjs',
      '--url',
      'https://example.workers.dev',
      '--expected-version',
      'abc1234'
    ])
  })

  it('MQA-316 refuses to construct a deployment smoke without its expected stamp', () => {
    expect(() => buildSmokeArgs({ url: 'https://example.workers.dev' })).toThrow(/expected.*version/i)
    expect(() => buildSmokeArgs({ url: 'https://example.workers.dev', expectedVersion: ' ' })).toThrow(/expected.*version/i)
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

describe('MQA-313 local deployment executables', () => {
  it('keeps every dry-run gate while avoiding npx resolution', () => {
    const output = execFileSync(process.execPath, [resolve(__dirname, 'deploy.mjs'), '--dry-run', '--env', 'production'], {
      encoding: 'utf8'
    }).replace(/\\/g, '/')
    expect(output).toContain('node_modules/typescript/bin/tsc --noEmit -p operator/tsconfig.json')
    expect(output).toContain('node_modules/typescript/bin/tsc --noEmit -p operator/client/tsconfig.json')
    expect(output).toContain('node_modules/vitest/vitest.mjs run --config operator/vitest.config.ts')
    expect(output).toContain('operator/scripts/migrate.mjs --remote')
    expect(output).toContain('node_modules/wrangler/bin/wrangler.js deploy --var OPERATOR_VERSION:')
    expect(output).toContain('operator/scripts/smoke.mjs --url')
    const stamp = /OPERATOR_VERSION:([a-f\d]+)/i.exec(output)?.[1]
    expect(stamp).toBeTruthy()
    expect(output).toContain(`--expected-version ${stamp}`)
    expect(output).not.toMatch(/&& npx /)
  })
})
