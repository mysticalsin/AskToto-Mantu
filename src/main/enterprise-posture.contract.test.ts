import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const mainSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
const settingsSrc = readFileSync(join(__dirname, '..', 'renderer', 'src', 'components', 'Settings.tsx'), 'utf8').replace(
  /\r\n/g,
  '\n'
)
const managedExample = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'build', 'managed-config.enterprise.example.json'), 'utf8')
) as { locked: string[]; dustBaseUrl: string; operatorUrl: string; sendAskText: boolean }

describe('support diagnostics bundle exports logs, not the audit trail', () => {
  it('copies main logs and only the current audit generation', () => {
    expect(mainSrc).toMatch(/if \(\/\^main\(\\\.old\)\?\\\.log\$\/\.test\(f\) \|\| f === 'audit\.log'\) copy\(join\(logsDir, f\), f\)/)
    expect(mainSrc).not.toMatch(/if \(\/\\\.log\$\/\.test\(f\)\) copy\(join\(logsDir, f\), f\)/)
  })

  it('the manifest says what audit.log carries and that archives are excluded', () => {
    expect(mainSrc).toContain('`audit.log (current generation only) records security events as metadata: the signed-in actor`')
    expect(mainSrc).toContain('rotated audit archives')
  })
})

describe('pre-sign-in import recovery backs off instead of polling at 1 Hz', () => {
  it('doubles the delay up to a cap', () => {
    expect(mainSrc).toMatch(/const recoverImports = \(delayMs = 1000\): void =>/)
    expect(mainSrc).toMatch(
      /setTimeout\(\(\) => recoverImports\(Math\.min\(delayMs \* 2, IMPORT_RECOVER_BACKOFF_CAP_MS\)\), delayMs\)/
    )
    expect(mainSrc).toMatch(/const IMPORT_RECOVER_BACKOFF_CAP_MS = 30_000/)
  })
})

describe('the Operator ingest secret never reaches the renderer', () => {
  it('publicSettings blanks the secret and exposes only a boolean', () => {
    expect(mainSrc).toMatch(/operatorIngestSecret: '',\n\s+operatorIngestSecretSet: /)
  })

  it('Settings renders a write-only field, never the stored value', () => {
    expect(settingsSrc).not.toMatch(/value=\{settings\.operatorIngestSecret/)
    expect(settingsSrc).toMatch(/operatorIngestSecretSet/)
  })
})

describe('enterprise managed-config example fixes the fleet posture', () => {
  it('locks the Operator channel off and pins Dust to the EU host', () => {
    for (const key of ['operatorUrl', 'operatorIngestSecret', 'sendAskText', 'dustBaseUrl']) {
      expect(managedExample.locked).toContain(key)
    }
    expect(managedExample.operatorUrl).toBe('')
    expect(managedExample.sendAskText).toBe(false)
    expect(managedExample.dustBaseUrl).toBe('https://eu.dust.tt')
  })
})
