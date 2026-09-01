import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cliConnectPatchIfLive, nextCliConnectStep } from './cli-connect'
import { applyInteractiveGuardrail, resolveModelTier, PROVIDERS } from './providers'

describe('nextCliConnectStep — one-click Connect walk', () => {
  it('missing binary triggers the install path (not a Connected badge)', () => {
    expect(
      nextCliConnectStep({
        binaryPresent: false,
        session: null,
        installAttempted: false,
        installOk: null,
        loginAttempted: false
      })
    ).toEqual({ action: 'install' })
  })

  it('a failed install fails loud and never connects', () => {
    expect(
      nextCliConnectStep({
        binaryPresent: false,
        session: null,
        installAttempted: true,
        installOk: false,
        loginAttempted: false
      })
    ).toEqual({ action: 'fail', reason: 'install-failed' })
  })

  it('install that still cannot find the binary is not Connected', () => {
    expect(
      nextCliConnectStep({
        binaryPresent: false,
        session: null,
        installAttempted: true,
        installOk: true,
        loginAttempted: false
      })
    ).toEqual({ action: 'fail', reason: 'missing-binary' })
  })

  it('installed + live session is detect + switch — connect only', () => {
    expect(
      nextCliConnectStep({
        binaryPresent: true,
        session: 'live',
        installAttempted: false,
        installOk: null,
        loginAttempted: false
      })
    ).toEqual({ action: 'connect' })
  })

  it('installed but signed out starts login, then waits — never bills', () => {
    expect(
      nextCliConnectStep({
        binaryPresent: true,
        session: 'signed-out',
        installAttempted: false,
        installOk: null,
        loginAttempted: false
      })
    ).toEqual({ action: 'login' })
    expect(
      nextCliConnectStep({
        binaryPresent: true,
        session: 'signed-out',
        installAttempted: true,
        installOk: true,
        loginAttempted: true
      })
    ).toEqual({ action: 'wait-login' })
  })
})

describe('cliConnectPatchIfLive — fake Connected is impossible without a live session', () => {
  it('returns null for signed-out and unknown — no cliConnected, no provider switch', () => {
    expect(cliConnectPatchIfLive('claude-cli', {}, 'signed-out')).toBeNull()
    expect(cliConnectPatchIfLive('codex-cli', {}, 'unknown')).toBeNull()
  })

  it('writes cliConnected AND provider only when the session is live', () => {
    expect(cliConnectPatchIfLive('claude-cli', {}, 'live')).toEqual({
      cliConnected: { 'claude-cli': true },
      provider: 'claude-cli'
    })
    expect(cliConnectPatchIfLive('codex-cli', { 'claude-cli': true }, 'live')).toEqual({
      cliConnected: { 'claude-cli': true, 'codex-cli': true },
      provider: 'codex-cli'
    })
  })
})

describe('one-click Connect never bills', () => {
  it('the walk module never mentions testCli / a billed prompt', () => {
    const src = readFileSync(join(__dirname, 'cli-connect.ts'), 'utf8')
    expect(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')).not.toMatch(
      /testCli|cliTest|Reply with OK/
    )
    expect(src).toMatch(/checkCliSession|live/)
  })
})

describe('Cloud CLI routing still Haiku / Sonnet / Opus after the one-click walk', () => {
  it('base is haiku, think is sonnet, deep is opus', () => {
    expect(PROVIDERS['claude-cli'].fastModel).toBe('haiku')
    expect(PROVIDERS['claude-cli'].thinkModel).toBe('sonnet')
    expect(PROVIDERS['claude-cli'].deepModel).toBe('opus')
    expect(applyInteractiveGuardrail('claude-cli', 'base', 'opus')).toBe('haiku')
    expect(applyInteractiveGuardrail('claude-cli', 'think', 'opus')).toBe('sonnet')
    expect(applyInteractiveGuardrail('claude-cli', 'deep', 'opus')).toBe('opus')
  })
})

describe('Codex CLI routing — default for fast, stronger model for coding/deep', () => {
  it('omits a model id on the base tier so the CLI uses its own default', () => {
    expect(PROVIDERS['codex-cli'].fastModel).toBe('')
    expect(resolveModelTier('codex-cli', {}, {}, 'base')).toBe('')
  })

  it('think and deep resolve to the stronger Codex model when the CLI supports it', () => {
    expect(PROVIDERS['codex-cli'].thinkModel).toBe('gpt-5.5')
    expect(PROVIDERS['codex-cli'].deepModel).toBe('gpt-5.5')
    expect(resolveModelTier('codex-cli', {}, {}, 'think')).toBe('gpt-5.5')
    expect(resolveModelTier('codex-cli', {}, {}, 'deep', {})).toBe('gpt-5.5')
  })
})
