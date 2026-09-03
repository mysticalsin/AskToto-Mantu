import { describe, expect, it } from 'vitest'
import {
  DUST_RETRIEVAL_ONLY,
  dustIsGeneralChat,
  filterFundedProviders,
  isDustChatForbidden,
  isOperatorHostedProviderId,
  nextAskRoute,
  nextLastClickedCli,
  pickWorkingCliPrimary,
  workingCliOrder
} from './ask-routing'

describe('OPERATOR.md Ask routing law', () => {
  it('sends every user question to the last-clicked working CLI first', () => {
    expect(
      pickWorkingCliPrimary({
        cliConnected: { 'claude-cli': true, 'codex-cli': true },
        lastClickedCli: 'codex-cli'
      })
    ).toBe('codex-cli')
    expect(
      nextAskRoute({
        cliConnected: { 'claude-cli': true, 'codex-cli': true },
        lastClickedCli: 'codex-cli',
        fundedProviders: ['anthropic']
      })
    ).toEqual({ provider: 'codex-cli', tier: 'cli' })
  })

  it('uses the other CLI after quota or rate limit, then Operator keys', () => {
    expect(
      workingCliOrder({
        cliConnected: { 'claude-cli': true, 'codex-cli': true },
        lastClickedCli: 'claude-cli'
      })
    ).toEqual(['claude-cli', 'codex-cli'])
    expect(
      nextAskRoute({
        cliConnected: { 'claude-cli': true, 'codex-cli': true },
        lastClickedCli: 'claude-cli',
        exhausted: ['claude-cli'],
        fundedProviders: ['openai']
      })
    ).toEqual({ provider: 'codex-cli', tier: 'cli' })
    expect(
      nextAskRoute({
        cliConnected: { 'claude-cli': true, 'codex-cli': true },
        lastClickedCli: 'claude-cli',
        exhausted: ['claude-cli', 'codex-cli'],
        fundedProviders: ['anthropic', 'openai']
      })
    ).toEqual({ provider: 'anthropic', tier: 'operator' })
  })

  it('never routes general chat to Dust and never funds CLI or local ids', () => {
    expect(DUST_RETRIEVAL_ONLY).toBe(true)
    expect(dustIsGeneralChat()).toBe(false)
    expect(isDustChatForbidden('dust', false)).toBe(true)
    expect(isDustChatForbidden('dust', true)).toBe(false)
    expect(
      nextAskRoute({
        cliConnected: {},
        fundedProviders: ['dust', 'anthropic']
      })
    ).toEqual({ provider: 'anthropic', tier: 'operator' })
    expect(isOperatorHostedProviderId('claude-cli')).toBe(false)
    expect(isOperatorHostedProviderId('codex-cli')).toBe(false)
    expect(isOperatorHostedProviderId('dust')).toBe(false)
    expect(isOperatorHostedProviderId('local')).toBe(false)
    expect(isOperatorHostedProviderId('cloudflare-account')).toBe(false)
    expect(filterFundedProviders(['claude-cli', 'dust', 'anthropic', 'local', 'sk-ant-secret'])).toEqual([
      'anthropic'
    ])
  })

  it('fails honestly when no CLI and no funded Operator provider remain', () => {
    expect(
      nextAskRoute({
        cliConnected: { 'claude-cli': true },
        exhausted: ['claude-cli'],
        fundedProviders: []
      })
    ).toEqual({ provider: '', tier: 'fail' })
  })

  it('honors the org allowlist and ignores a disconnected last-clicked CLI', () => {
    expect(
      pickWorkingCliPrimary({
        cliConnected: { 'claude-cli': true, 'codex-cli': true },
        lastClickedCli: 'claude-cli',
        allowed: ['codex-cli']
      })
    ).toBe('codex-cli')
    expect(
      pickWorkingCliPrimary({
        cliConnected: { 'claude-cli': false, 'codex-cli': true },
        lastClickedCli: 'claude-cli'
      })
    ).toBe('codex-cli')
  })

  it('clears last-clicked on disconnect without inventing a vault row', () => {
    expect(
      nextLastClickedCli('claude-cli', 'claude-cli', { 'claude-cli': false, 'codex-cli': true })
    ).toBe('codex-cli')
    expect(nextLastClickedCli('claude-cli', 'claude-cli', { 'claude-cli': false, 'codex-cli': false })).toBe(
      null
    )
    expect(nextLastClickedCli('codex-cli', 'claude-cli', { 'claude-cli': false, 'codex-cli': true })).toBe(
      'codex-cli'
    )
  })
})
