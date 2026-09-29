import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }))
vi.mock('../../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))

import { argsFingerprint, createSidecarRegistry, type ProcessIdentity } from './registry'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'metis-registry-'))
  dirs.push(dir)
  return dir
}

function identityFor(pid: number, executable: string, args: readonly string[], pgid = pid): ProcessIdentity {
  return {
    pid,
    pgid,
    osStartTime: '2026-01-01T00:00:00.000Z',
    exeRealpath: realpathSync(executable),
    args: [executable, ...args]
  }
}

function readRecords(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('recordSupervisedSpawned', () => {
  const helper = process.execPath
  const sidecar = process.execPath
  const wrapperArgs = ['supervise', '--parent', '1', '--', sidecar, '--port', '0']
  const sidecarArgs = ['--port', '0']

  it('records the wrapper and the real sidecar it spawned as separate reapable identities', async () => {
    const identities = new Map<number, ProcessIdentity>([
      [100, identityFor(100, helper, wrapperArgs)],
      [101, identityFor(101, sidecar, sidecarArgs, 100)]
    ])
    const registry = createSidecarRegistry(tempUserData(), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', {
      getIdentity: async (pid) => identities.get(pid) ?? null,
      findChildPid: async (parent) => (parent === 100 ? 101 : null)
    })

    await registry.recordSupervisedSpawned(
      'llama-server',
      { pid: 100 } as ChildProcess,
      { executable: helper, args: wrapperArgs },
      { executable: sidecar, args: sidecarArgs }
    )

    const records = readRecords(registry.path)
    expect(records.map((r) => [r.kind, r.name, r.pid, r.pgid])).toEqual([
      ['spawned', 'llama-server', 100, 100],
      ['spawned', 'llama-server', 101, 100]
    ])
    expect(records[0].argsFingerprint).toBe(argsFingerprint(wrapperArgs))
    expect(records[1].argsFingerprint).toBe(argsFingerprint(sidecarArgs))
  })

  it('still records the wrapper when the sidecar child cannot be found', async () => {
    const registry = createSidecarRegistry(tempUserData(), 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', {
      getIdentity: async (pid) => identityFor(pid, helper, wrapperArgs),
      findChildPid: async () => null
    })

    await registry.recordSupervisedSpawned(
      'llama-server',
      { pid: 200 } as ChildProcess,
      { executable: helper, args: wrapperArgs },
      { executable: sidecar, args: sidecarArgs }
    )

    expect(readRecords(registry.path).map((r) => r.pid)).toEqual([200])
  })

  it('writes nothing for a sidecar whose identity does not match what was launched', async () => {
    const registry = createSidecarRegistry(tempUserData(), 'cccccccc-cccc-cccc-cccc-cccccccccccc', {
      getIdentity: async (pid) => identityFor(pid, helper, ['something', 'else']),
      findChildPid: async () => 301
    })

    await registry.recordSupervisedSpawned(
      'llama-server',
      { pid: 300 } as ChildProcess,
      { executable: helper, args: wrapperArgs },
      { executable: sidecar, args: sidecarArgs }
    )

    expect(() => readRecords(registry.path)).toThrow()
  })
})
