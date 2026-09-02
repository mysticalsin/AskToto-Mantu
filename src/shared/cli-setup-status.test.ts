import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canShowConnected, cliSetupChip, nextCliSetupStep } from './cli-setup-status'

describe('cli setup status machine — Installing → Waiting for login → Connected', () => {
  it('missing binary triggers install and cannot show Connected', () => {
    expect(
      nextCliSetupStep({
        binaryPresent: false,
        testOk: false,
        installAttempted: false,
        installOk: null,
        loginAttempted: false
      })
    ).toEqual({ action: 'install' })
    expect(canShowConnected({ binaryPresent: false, testOk: false })).toBe(false)
    expect(canShowConnected({ binaryPresent: false, testOk: true })).toBe(false)
    expect(
      cliSetupChip({
        binaryPresent: false,
        testOk: true,
        installing: false,
        loginOpened: false,
        error: null
      }).kind
    ).not.toBe('connected')
  })

  it('a failed install fails loud and never connects', () => {
    expect(
      nextCliSetupStep({
        binaryPresent: false,
        testOk: false,
        installAttempted: true,
        installOk: false,
        loginAttempted: false
      })
    ).toEqual({ action: 'fail', reason: 'install-failed' })
    expect(
      cliSetupChip({
        binaryPresent: false,
        testOk: false,
        installing: false,
        loginOpened: false,
        error: 'npm EACCES'
      })
    ).toEqual({ kind: 'failed', label: 'npm EACCES' })
  })

  it('install that still cannot find the binary is not Connected', () => {
    expect(
      nextCliSetupStep({
        binaryPresent: false,
        testOk: false,
        installAttempted: true,
        installOk: true,
        loginAttempted: false
      })
    ).toEqual({ action: 'fail', reason: 'missing-binary' })
  })

  it('binary + successful testCli is Connected; chip labels are honest', () => {
    expect(
      nextCliSetupStep({
        binaryPresent: true,
        testOk: true,
        installAttempted: false,
        installOk: null,
        loginAttempted: false
      })
    ).toEqual({ action: 'connect' })
    expect(canShowConnected({ binaryPresent: true, testOk: true })).toBe(true)
    expect(
      cliSetupChip({
        binaryPresent: false,
        testOk: false,
        installing: true,
        loginOpened: false,
        error: null
      })
    ).toEqual({ kind: 'installing', label: 'Installing' })
    expect(
      cliSetupChip({
        binaryPresent: true,
        testOk: false,
        installing: false,
        loginOpened: true,
        error: null
      })
    ).toEqual({ kind: 'waiting-for-login', label: 'Waiting for login' })
    expect(
      cliSetupChip({
        binaryPresent: true,
        testOk: true,
        installing: false,
        loginOpened: false,
        error: null
      })
    ).toEqual({ kind: 'connected', label: 'Connected' })
  })

  it('installed but signed out opens login, then waits — a click without a working binary cannot Connect', () => {
    expect(
      nextCliSetupStep({
        binaryPresent: true,
        testOk: false,
        installAttempted: false,
        installOk: null,
        loginAttempted: false
      })
    ).toEqual({ action: 'login' })
    expect(
      nextCliSetupStep({
        binaryPresent: true,
        testOk: false,
        installAttempted: true,
        installOk: true,
        loginAttempted: true
      })
    ).toEqual({ action: 'wait-login' })
    expect(canShowConnected({ binaryPresent: true, testOk: false })).toBe(false)
  })
})

describe('CLI setup never stores tokens in the Operator vault', () => {
  it('the walk module and Settings CLI card do not write vault secrets', () => {
    const walk = readFileSync(join(__dirname, './cli-setup-status.ts'), 'utf8')
    const settings = readFileSync(join(__dirname, '../renderer/src/components/Settings.tsx'), 'utf8')
    const card = settings.slice(settings.indexOf('function CliIntegration('), settings.indexOf('function McpConnectionCard('))
    const stripped = `${walk}\n${card}`.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(stripped).not.toMatch(/operatorVault|writeSecret|mcpSecrets|safeStorage\.encrypt/)
    expect(walk.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')).not.toMatch(
      /token|apiKey|vault/
    )
    expect(card).toMatch(/canShowConnected/)
    expect(card).toMatch(/data-cli-setup-chip/)
    expect(card).toMatch(/Set up automatically/)
    expect(card).toMatch(/Waiting for login/)
    expect(settings).toMatch(/haltAllOnboardingAudio\(\)/)
  })
})
