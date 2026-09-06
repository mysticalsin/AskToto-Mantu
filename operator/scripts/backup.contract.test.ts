import { describe, expect, it } from 'vitest'
import { backupFileName, buildExportArgs, buildRestorePlan, formatBackupDate, parseArgs, resolveDbName } from './backup.mjs'

describe('resolveDbName', () => {
  it('production is metis-operator', () => {
    expect(resolveDbName('production')).toBe('metis-operator')
  })
  it('staging is metis-operator-staging', () => {
    expect(resolveDbName('staging')).toBe('metis-operator-staging')
  })
  it('anything else falls back to production (safe default)', () => {
    expect(resolveDbName(undefined)).toBe('metis-operator')
  })
})

describe('formatBackupDate', () => {
  it('is filesystem-safe: no colons, no milliseconds', () => {
    const d = new Date('2026-09-06T13:05:07.123Z')
    const formatted = formatBackupDate(d)
    expect(formatted).toBe('2026-09-06T130507Z')
    expect(formatted).not.toContain(':')
    expect(formatted).not.toContain('.')
  })
})

describe('backupFileName', () => {
  it('embeds the resolved db name and formatted date', () => {
    const d = new Date('2026-09-06T13:05:07.000Z')
    expect(backupFileName('staging', d)).toBe('metis-operator-staging-2026-09-06T130507Z.sql')
    expect(backupFileName('production', d)).toBe('metis-operator-2026-09-06T130507Z.sql')
  })
})

describe('buildExportArgs', () => {
  it('production: no --env flag', () => {
    const args = buildExportArgs({ env: 'production', outFile: 'backups/x.sql' })
    expect(args).toEqual(['d1', 'export', 'metis-operator', '--remote', '--output', 'backups/x.sql'])
  })
  it('staging: appends --env staging', () => {
    const args = buildExportArgs({ env: 'staging', outFile: 'backups/x.sql' })
    expect(args).toEqual([
      'd1',
      'export',
      'metis-operator-staging',
      '--remote',
      '--output',
      'backups/x.sql',
      '--env',
      'staging'
    ])
  })
})

describe('buildRestorePlan', () => {
  it('mentions D1 Time Travel before the destructive SQL-file restore', () => {
    const plan = buildRestorePlan({ env: 'production', file: 'backup.sql' })
    expect(plan[0].comment).toContain('Time Travel')
    expect(plan[0].command).toBeUndefined()
    expect(plan[1].command).toEqual(['d1', 'execute', 'metis-operator', '--file=backup.sql', '--remote'])
  })
  it('staging plan carries --env staging on the executable command', () => {
    const plan = buildRestorePlan({ env: 'staging', file: 'backup.sql' })
    const execStep = plan.find((s) => s.command)
    expect(execStep.command).toEqual([
      'd1',
      'execute',
      'metis-operator-staging',
      '--file=backup.sql',
      '--remote',
      '--env',
      'staging'
    ])
  })
})

describe('parseArgs', () => {
  it('defaults to production export, no dry-run, no restore', () => {
    const args = parseArgs([])
    expect(args).toMatchObject({ env: 'production', dryRun: false, restore: null, yes: false })
  })
  it('reads --env, --dry-run, --restore, --yes', () => {
    const args = parseArgs(['--env', 'staging', '--dry-run', '--restore', 'x.sql', '--yes'])
    expect(args).toMatchObject({ env: 'staging', dryRun: true, restore: 'x.sql', yes: true })
  })
  it('rejects an invalid --env rather than silently defaulting', () => {
    expect(() => parseArgs(['--env', 'prod'])).toThrow(/must be "production" or "staging"/)
  })
})
