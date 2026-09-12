import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { commandFailureDetails, localNodeCommand } from './toolchain.mjs'

const root = resolve(__dirname, '../..')

describe('MQA-313 reproducible deployment tools', () => {
  it('pins the observed Wrangler version in the manifest and lockfile', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'))
    expect(pkg.version).toBe(lock.version)
    expect(pkg.devDependencies.wrangler).toBe('4.131.1')
    expect(lock.packages[''].devDependencies.wrangler).toBe('4.131.1')
    expect(lock.packages['node_modules/wrangler'].version).toBe('4.131.1')
  })

  it('requires the installed Wrangler to match the committed pin', () => {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    const installed = JSON.parse(readFileSync(resolve(root, 'node_modules/wrangler/package.json'), 'utf8'))
    expect(installed.version).toBe(pkg.devDependencies.wrangler)
  })

  it.each([
    ['wrangler', 'wrangler/bin/wrangler.js'],
    ['typescript', 'typescript/bin/tsc'],
    ['vitest', 'vitest/vitest.mjs']
  ])('runs %s through the current Node and local dependency only', (tool, entry) => {
    expect(localNodeCommand(tool, ['--version'])).toEqual({
      cmd: process.execPath,
      args: [resolve(root, 'node_modules', entry), '--version']
    })
  })

  it('does not resolve arbitrary tool names or execute a shell', () => {
    expect(() => localNodeCommand('npx', ['wrangler@latest'])).toThrow(/unsupported local tool/i)
  })

  it('preserves unexplained process exits and signals in diagnostics', () => {
    expect(commandFailureDetails({ status: 1, signal: null, stdout: '', stderr: '' }))
      .toContain('exit=1 signal=none error=none')
    expect(commandFailureDetails({ status: null, signal: 'SIGKILL', stdout: '', stderr: '' }))
      .toContain('exit=null signal=SIGKILL error=none')
    expect(commandFailureDetails({ status: null, signal: null, error: { code: 'ENOENT' } }))
      .toContain('exit=null signal=none error=ENOENT')
  })
})
