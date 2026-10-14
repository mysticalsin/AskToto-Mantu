import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const childProcess = vi.hoisted(() => ({ execFileSync: vi.fn() }))
vi.mock('node:child_process', () => childProcess)

// Exercise the pinned builder's real normalization and matcher behavior, rather than testing only
// whether an exclusion string was appended somewhere in the configuration object.
const require = createRequire(import.meta.url)
const { doMergeConfigs } = require('app-builder-lib/out/util/config/config')
const { getMainFileMatchers } = require('app-builder-lib/out/fileMatcher')
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metis-lean-matchers-'))
  childProcess.execFileSync.mockReset()
  vi.stubEnv('METIS_PACKAGE_PROFILE', 'lean')
  vi.stubEnv('METIS_PACKAGE_ARCH', 'x64')
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

it.each([
  'darwin',
  'win32'
] as const)('excludes inference workers from normalized %s file sets while retaining application entries', async (platform) => {
  const config = doMergeConfigs([{ files: ['out/**/*', 'package.json'], mac: {}, win: {} }])
  const info = {
    config,
    projectDir: root,
    appDir: root,
    buildResourcesDir: 'build',
    isPrepackedAppAsar: false,
    debugLogger: { isEnabled: false }
  }
  const packager = { config, info }
  const beforePack = (await import('./before-pack.mjs')).default
  await beforePack({ arch: 1, electronPlatformName: platform, packager })
  const target = platform === 'darwin' ? config.mac : config.win
  const matchers = getMainFileMatchers(
    root,
    join(root, 'packaged'),
    (value: string) => value,
    target,
    packager,
    join(root, 'release'),
    false
  )
  const admitted = (relative: string): boolean => {
    const path = join(root, ...relative.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'synthetic-builder-fixture')
    return matchers.some((matcher: { createFilter(): (path: string, stat: ReturnType<typeof lstatSync>) => boolean }) =>
      matcher.createFilter()(path, lstatSync(path))
    )
  }
  expect(matchers).toHaveLength(1)
  for (const file of [
    'out/main/parakeet-asr-host.js',
    'out/main/parakeet-asr-host.jsc',
    'out/main/whisper-asr-host.js',
    'out/main/speaker-embedding-host.js',
    'out/main/parakeet-extract-host.js',
    'out/renderer/assets/whisper.worker-fixture.js'
  ])
    expect(admitted(file), file).toBe(false)
  expect(admitted('out/main/index.js')).toBe(true)
  expect(admitted('out/preload/index.js')).toBe(true)
  expect(admitted('out/renderer/index.html')).toBe(true)
  expect(admitted('package.json')).toBe(true)
  expect(admitted('private-source-fixture.ts')).toBe(false)
})
