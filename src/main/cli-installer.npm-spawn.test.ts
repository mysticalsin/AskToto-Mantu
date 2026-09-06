import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron')
vi.mock('./managed-node', () => ({
  resolveManagedNode: vi.fn(),
  ensureManagedNode: vi.fn()
}))

import { resolveManagedNode } from './managed-node'
import {
  ManagedNpmMissingError,
  npmInstallProductionSpawn,
  planNpmInstallSpawn,
  resolveNpmCliJs,
  sanitizedSpawnEnv
} from './cli-installer'

const resolve = vi.mocked(resolveManagedNode)

describe('MQA-287 — managed Dust npm spawn never uses PATH npm or the shebang shim', () => {
  afterEach(() => {
    resolve.mockReset()
  })

  it('resolves npm-cli.js from official unix and windows Node layouts', () => {
    const root = mkdtempSync(join(tmpdir(), 'asktoto-npm-cli-'))
    const unixBin = join(root, 'unix', 'bin')
    const unixLib = join(root, 'unix', 'lib', 'node_modules', 'npm', 'bin')
    mkdirSync(unixLib, { recursive: true })
    writeFileSync(join(unixLib, 'npm-cli.js'), 'module.exports = {}\n')
    expect(resolveNpmCliJs(join(unixBin, 'node'))).toBe(join(unixLib, 'npm-cli.js'))

    const winRoot = join(root, 'win')
    const winNpm = join(winRoot, 'node_modules', 'npm', 'bin')
    mkdirSync(winNpm, { recursive: true })
    writeFileSync(join(winNpm, 'npm-cli.js'), 'module.exports = {}\n')
    expect(resolveNpmCliJs(join(winRoot, 'node.exe'))).toBe(join(winNpm, 'npm-cli.js'))
  })

  it('spawns portable node + npm-cli.js, never bin/npm', () => {
    const root = mkdtempSync(join(tmpdir(), 'asktoto-npm-spawn-'))
    const bin = join(root, 'bin')
    const cli = join(root, 'lib', 'node_modules', 'npm', 'bin')
    mkdirSync(cli, { recursive: true })
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'node'), '')
    writeFileSync(join(bin, 'npm'), '#!/usr/bin/env node\n')
    writeFileSync(join(cli, 'npm-cli.js'), '')
    resolve.mockReturnValue({
      node: join(bin, 'node'),
      npm: join(bin, 'npm'),
      source: 'userData'
    })
    const spec = npmInstallProductionSpawn()
    expect(spec.command).toBe(join(bin, 'node'))
    expect(spec.args[0]).toBe(join(cli, 'npm-cli.js'))
    expect(spec.args.slice(1)).toEqual(['install', '--omit=dev', '--no-fund', '--no-audit'])
    expect(spec.command).not.toMatch(/npm$/)
  })

  it('fails loud when Node and npm-cli.js are missing (Windows and Mac)', () => {
    resolve.mockReturnValue(null)
    expect(() =>
      planNpmInstallSpawn({
        portableNode: null,
        execPath: process.platform === 'win32' ? 'C:\\Metis\\Metis.exe' : '/Applications/Metis.app/Contents/MacOS/Metis',
        exists: () => false
      })
    ).toThrow(ManagedNpmMissingError)
  })

  it('sanitized spawn env drops secrets (Windows Path included)', () => {
    const env = sanitizedSpawnEnv({
      PATH: '/usr/bin',
      Path: 'C:\\Windows\\System32',
      DUST_API_KEY: 'sk-secret-should-not-leak',
      OPENAI_API_KEY: 'sk-openai',
      TEMP: '/tmp',
      SYSTEMROOT: 'C:\\Windows'
    })
    expect(env.DUST_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.PATH || env.Path).toBeTruthy()
    expect(JSON.stringify(env)).not.toMatch(/sk-secret|sk-openai/)
  })
})
