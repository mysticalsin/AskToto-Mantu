import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const indexSrc = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const ingestSrc = readFileSync(join(__dirname, 'operator-ingest.ts'), 'utf8')
const operatorAskSrc = readFileSync(join(__dirname, 'llm/operator-ask.ts'), 'utf8')
const settingsSrc = readFileSync(join(__dirname, '../renderer/src/components/Settings.tsx'), 'utf8')

describe('Operator-funded Ask consumption — seat never stores raw LLM keys', () => {
  it('Ask primary is last-clicked working CLI, then Operator-funded after CLI quota', () => {
    expect(indexSrc).toMatch(/pickWorkingCliPrimary/)
    expect(indexSrc).toMatch(/nextAskRoute/)
    expect(indexSrc).toMatch(/workingCliOrder/)
    expect(indexSrc).toMatch(/operatorFundedProviders\(\)/)
    expect(indexSrc).toMatch(/lastClickedCli/)
    expect(indexSrc).toMatch(/isDustChatForbidden/)
    expect(indexSrc).toMatch(/viaOperator/)
    expect(indexSrc).toMatch(/operatorAskTransport/)
  })

  it('CLI connect records lastClickedCli and never vaults a CLI token', () => {
    expect(indexSrc).toMatch(/if \(isCliProviderId\(p\)\) next\.lastClickedCli = p/)
    expect(indexSrc).toMatch(/nextLastClickedCli/)
    expect(indexSrc).not.toMatch(/operatorVault|writeSecret/)
    expect(settingsSrc).toMatch(/CLI Integration/)
    expect(settingsSrc).toMatch(/lastClickedCli/)
    expect(settingsSrc).not.toMatch(/kind:\s*'vault'/)
  })

  it('heartbeat fundedProviders stay in RAM and Ask proxies without setApiKey', () => {
    expect(ingestSrc).toMatch(/lastFundedProviders/)
    expect(ingestSrc).toMatch(/Never a secret\. Never persisted/)
    expect(ingestSrc).toMatch(/fundedProvidersFromHeartbeat/)
    expect(operatorAskSrc).toMatch(/\/v1\/ask/)
    expect(operatorAskSrc).toMatch(/never persists it/)
    expect(operatorAskSrc).not.toMatch(/setApiKey/)
    expect(indexSrc).not.toMatch(/setApiKey\([^)]*operatorFunded/)
  })
})
