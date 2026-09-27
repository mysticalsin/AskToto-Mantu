import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, IPC, type Settings } from '@shared/ipc'
import type { BrainStatus } from '@shared/brain'
import type { ContentPresence } from './infra/storage/dataless'
import type { StorageFs } from './infra/storage/gateway'
import { useStorageForTests } from './infra/storage/meetings-storage'
import { readBrainStatus } from './brain/status'

const fsTrap = vi.hoisted(() => ({
  armed: false,
  calls: [] as string[],
  cloud: new Set<string>(),
  reads: [] as string[]
}))

const syncCallsOn = (...names: string[]): string[] => fsTrap.calls.filter((call) => names.includes(call.split(' ').at(-1) ?? ''))

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '') } }))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  const syncNames = [
    'accessSync',
    'appendFileSync',
    'chmodSync',
    'chownSync',
    'closeSync',
    'copyFileSync',
    'cpSync',
    'existsSync',
    'fchmodSync',
    'fchownSync',
    'fdatasyncSync',
    'fstatSync',
    'fsyncSync',
    'ftruncateSync',
    'futimesSync',
    'lchmodSync',
    'lchownSync',
    'linkSync',
    'lstatSync',
    'lutimesSync',
    'mkdirSync',
    'mkdtempSync',
    'openSync',
    'opendirSync',
    'readFileSync',
    'readdirSync',
    'readlinkSync',
    'readSync',
    'readvSync',
    'realpathSync',
    'renameSync',
    'rmSync',
    'rmdirSync',
    'statSync',
    'symlinkSync',
    'truncateSync',
    'unlinkSync',
    'utimesSync',
    'writeFileSync',
    'writeSync',
    'writevSync'
  ] as const
  const wrapped: Record<string, unknown> = { ...actual }
  for (const name of syncNames) {
    const fn = actual[name]
    if (typeof fn !== 'function') continue
    wrapped[name] = vi.fn((...args: unknown[]) => {
      if (fsTrap.armed) {
        for (const arg of args) {
          if (typeof arg !== 'string') continue
          const base = basename(arg)
          fsTrap.calls.push(`${name} ${base}`)
          if (fsTrap.cloud.has(base)) throw new Error(`${name} of a cloud-only file`)
        }
      }
      return (fn as (...inner: unknown[]) => unknown)(...args)
    })
  }
  return wrapped
})

type ExtractedBoundary = {
  channelText: string
  handler: (...args: unknown[]) => unknown
}

function boundary(channelText: string, globals: Record<string, unknown>): ExtractedBoundary {
  const file = join(__dirname, 'index.ts')
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  let callback: ts.Node | undefined
  let matchedChannelText = ''
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'ipcMain.handle' &&
      node.arguments[0]?.getText(source) === channelText
    ) {
      matchedChannelText = node.arguments[0].getText(source)
      callback = node.arguments[1]
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!callback) throw new Error(`Actual ${channelText} ipcMain.handle boundary not found`)
  const code = ts.transpileModule(`globalThis.result = (${callback.getText(source)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
  }).outputText
  const context = vm.createContext(globals)
  vm.runInContext(code, context, { timeout: 1_000 })
  return { channelText: matchedChannelText, handler: context.result as (...args: unknown[]) => unknown }
}

function installStorage(): void {
  const fs: StorageFs = {
    readdir: fsp.readdir,
    realpath: fsp.realpath,
    stat: fsp.stat,
    async readFile(path) {
      fsTrap.reads.push(basename(path))
      return fsp.readFile(path)
    }
  }
  useStorageForTests({
    detector: {
      classify: vi.fn(async (files: readonly { path: string }[]): Promise<Map<string, ContentPresence>> => new Map(files.map((file): [string, ContentPresence] => [
        file.path,
        fsTrap.cloud.has(basename(file.path)) ? 'dataless' : 'local'
      ]))),
      markLocal: vi.fn()
    },
    fs
  })
}

async function within<T>(promise: Promise<T>, deadlineMs: number): Promise<{ value: T; elapsedMs: number }> {
  const startedAt = performance.now()
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`handler did not settle within ${deadlineMs}ms`)), deadlineMs)
  })
  const value = await Promise.race([promise, timeout])
  return { value, elapsedMs: performance.now() - startedAt }
}

describe('index brainStatus IPC stall path', () => {
  let meetingsFolder: string
  let settings: Settings

  beforeEach(() => {
    fsTrap.armed = false
    fsTrap.calls.length = 0
    fsTrap.cloud.clear()
    fsTrap.reads.length = 0
    meetingsFolder = mkdtempSync(join(tmpdir(), 'm2-0031-ipc-meetings-'))
    settings = { ...DEFAULT_SETTINGS, meetingsFolder, encryptTranscripts: false }
    installStorage()
  })

  afterEach(() => {
    fsTrap.armed = false
    rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    vi.restoreAllMocks()
  })

  it('executes the registered IPC.brainStatus handler without blocking or opening a cloud-only index', async () => {
    mkdirSync(join(meetingsFolder, '.brain'), { recursive: true })
    writeFileSync(join(meetingsFolder, '.brain', 'index.json'), JSON.stringify({ schema_version: 0, ingested: {} }), 'utf8')
    const { channelText, handler } = boundary('IPC.brainStatus', {
      assertBrainReader: vi.fn(),
      requireAuth: () => true,
      readBrainStatus,
      getSettings: () => settings
    })
    fsTrap.cloud.add('index.json')
    fsTrap.armed = true

    expect(channelText).toBe('IPC.brainStatus')
    const { value: status, elapsedMs } = await within(Promise.resolve(handler({})), 500)

    expect(elapsedMs).toBeLessThan(500)
    expect(status as BrainStatus).toEqual(expect.objectContaining({
      indexUnavailable: 'cloud-only',
      error: expect.stringMatching(/\S/)
    }))
    expect(fsTrap.reads).not.toContain('index.json')
    expect(syncCallsOn('index.json', basename(meetingsFolder), '.brain')).toEqual([])
  })
})
