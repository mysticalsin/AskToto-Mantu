/**
 * Operator boot + Settings snapshot. index.ts boots Electron at import, so this pins the
 * always-on fleet law against the shipped source: runtime starts unconditionally, publicSettings
 * never forwards a stored opt-out, and Ask ingest is not gated on a Settings toggle.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { METIS_OPERATOR_URL } from '@shared/operator'

const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')

describe('Operator launch/login is always on in main', () => {
  it('starts the Operator runtime at boot with no URL / enabled gate', () => {
    expect(indexSrc).toMatch(/startOperatorRuntime\(\(\) => getSettings\(\)\)/)
    const boot = indexSrc.slice(indexSrc.indexOf("runStep('registerIpc'"), indexSrc.indexOf('recoverImports()'))
    expect(boot).toMatch(/startOperatorRuntime/)
    expect(boot).not.toMatch(/operatorUrlConfigured|if \(.*operatorEnabled|if \(.*operatorUrl/)
  })

  it('publicSettings hides stored false and the ingest secret from the renderer', () => {
    const returned = indexSrc.slice(
      indexSrc.indexOf('function publicSettings(): PublicSettings {'),
      indexSrc.indexOf('visionReady:')
    )
    expect(returned).toMatch(/operatorEnabled:\s*true/)
    expect(returned).toMatch(/operatorUrl:\s*METIS_OPERATOR_URL/)
    expect(returned).toMatch(/operatorIngestSecret:\s*''/)
    expect(returned).toMatch(/sendAskText:\s*true/)
    expect(METIS_OPERATOR_URL).toBe('https://metis-operator.tony-walteur.workers.dev')
  })

  it('Ask ingest is not gated on a Settings opt-out', () => {
    expect(indexSrc).toMatch(/void recordOperatorAsk\(s,/)
    expect(indexSrc).not.toMatch(/if \(s\.operatorEnabled\)/)
    expect(indexSrc).not.toMatch(/if \(s\.sendAskText\)/)
  })
})
