import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import afterPack, { resolveAfterPackTarget } from './after-pack.mjs'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makePackageTree(platform: 'darwin' | 'win32' | 'mas' = 'darwin') {
  const appOutDir = await mkdtemp(join(tmpdir(), 'metis-after-pack-'))
  temporaryRoots.push(appOutDir)
  const productFilename = 'Metis'
  const isMac = platform === 'darwin' || platform === 'mas'
  const resourceDir = isMac
    ? join(appOutDir, `${productFilename}.app`, 'Contents', 'Resources')
    : join(appOutDir, 'resources')
  const targetDir = platform === 'win32' ? 'win32-x64' : 'darwin-arm64'
  const binary = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  await mkdir(join(resourceDir, 'ffmpeg', targetDir), { recursive: true })
  await writeFile(join(resourceDir, 'ffmpeg', targetDir, binary), 'binary')
  return { appOutDir, productFilename, resourceDir }
}

function context(platform: string, arch: number, appOutDir = '/tmp/output', productFilename = 'Metis') {
  return {
    electronPlatformName: platform,
    arch,
    appOutDir,
    packager: { appInfo: { productFilename } }
  }
}

describe('macOS bundle branding', () => {
  it('keeps Métis visible while matching the NFD executable and helper paths internally', () => {
    const config = readFileSync(resolve('electron-builder.yml'), 'utf8')
    const internalName = /CFBundleName:\s*"([^"]+)"/.exec(config)?.[1]
    const displayName = /CFBundleDisplayName:\s*"([^"]+)"/.exec(config)?.[1]

    expect(internalName).toBe('Me\\u0301tis')
    expect(JSON.parse(`"${internalName}"`)).toBe('Métis'.normalize('NFD'))
    expect(displayName).toBe('Métis')
    expect(displayName?.normalize('NFC')).toBe(displayName)
  })

  it('packages only the target Sherpa runtime and keeps the Windows binary ASCII-safe', () => {
    const config = readFileSync(resolve('electron-builder.yml'), 'utf8')
    const mac = config.slice(config.indexOf('\nmac:'), config.indexOf('\nmas:'))
    const windows = config.slice(config.indexOf('\nwin:'), config.indexOf('\nnsis:'))

    expect(mac).toContain('!node_modules/sherpa-onnx-win-*/**')
    expect(mac).toContain('!node_modules/sherpa-onnx-linux-*/**')
    expect(mac).toContain('!node_modules/sherpa-onnx-darwin-x64/**')
    expect(windows).toContain('executableName: Metis')
    expect(windows).toContain('!node_modules/sherpa-onnx-darwin-*/**')
    expect(windows).toContain('!node_modules/sherpa-onnx-linux-*/**')
    expect(windows).toContain('!node_modules/sherpa-onnx-win-ia32/**')
  })

  it('excludes the node-llama source and local-build trees while retaining runtime metadata and grammars', () => {
    const config = readFileSync(resolve('electron-builder.yml'), 'utf8')
    const excluded = [
      'addon/**',
      'cmake/**',
      'gpuInfo/**',
      'patches/**',
      'profiles/**',
      'toolchains/**',
      'xpack/**',
      'gitRelease.bundle',
      'CMakeLists.txt',
      '.clang-format'
    ]

    for (const path of excluded) {
      expect(config).toContain(`- '!node_modules/node-llama-cpp/llama/${path}'`)
    }
    expect(config).not.toContain("!node_modules/node-llama-cpp/llama/binariesGithubRelease.json")
    expect(config).not.toContain("!node_modules/node-llama-cpp/llama/llama.cpp.info.json")
    expect(config).not.toContain("!node_modules/node-llama-cpp/llama/package.json")
    expect(config).not.toContain("!node_modules/node-llama-cpp/llama/grammars/**")
    expect(config).not.toContain("!node_modules/node-llama-cpp/llama/**")
  })

  it('attributes the installed node-llama JavaScript and native packages from their bundled licenses', () => {
    const notices = readFileSync(resolve('THIRD_PARTY_NOTICES.md'), 'utf8')

    expect(notices).toContain('node-llama-cpp 3.19.0')
    expect(notices).toContain('Copyright (c) 2023 Gilad S.')
    expect(notices).toContain('@node-llama-cpp platform binaries 3.19.0')
    expect(notices).toContain('Copyright (c) 2024 Gilad S.')
    expect(notices).toContain('MIT License')
    expect(notices).toContain('ggml-org/llama.cpp release `b9842`')
    expect(notices).toContain('### ggml-org/llama.cpp b9842')
    expect(notices).toContain('Copyright (c) 2023-2026 The ggml authors')
    expect(notices).toContain('Permission is hereby granted, free of charge')
    expect(notices).toContain('THE SOFTWARE IS PROVIDED "AS IS"')
  })
})

describe('afterPack target selection', () => {
  it('maps only the supported direct macOS target', () => {
    expect(resolveAfterPackTarget(context('darwin', 3))).toEqual({
      kind: 'direct',
      isMac: true,
      platform: 'darwin-arm64',
      targetDir: 'darwin-arm64'
    })
  })

  it('maps only the supported direct Windows target', () => {
    expect(resolveAfterPackTarget(context('win32', 1))).toEqual({
      kind: 'direct',
      isMac: false,
      platform: 'win32-x64',
      targetDir: 'win32-x64'
    })
  })

  it.each([
    ['darwin', 1],
    ['win32', 3],
    ['linux', 1],
    ['darwin', 4]
  ])('rejects unsupported direct target %s arch enum %s', (platform, arch) => {
    expect(() => resolveAfterPackTarget(context(platform, arch))).toThrow(/Unsupported direct package target/)
  })

  it.each(['mas', 'mas-dev'])('handles the arm64 %s target as an explicit local-tier-disabled package', (platform) => {
    expect(resolveAfterPackTarget(context(platform, 3))).toEqual({
      kind: 'mas',
      isMac: true,
      targetDir: 'darwin-arm64'
    })
  })

  it('rejects an unsupported MAS architecture separately from direct targets', () => {
    expect(() => resolveAfterPackTarget(context('mas', 1))).toThrow(/Unsupported MAS package target/)
  })
})

describe('afterPack behavior', () => {
  it('checks the supported direct package with the explicit platform mapping', async () => {
    const tree = await makePackageTree('darwin')
    const checkNodeLlamaPackage = vi.fn().mockResolvedValue(undefined)

    await afterPack(context('darwin', 3, tree.appOutDir, tree.productFilename), {
      checkNodeLlamaPackage,
      execFileSync: vi.fn()
    })

    expect(checkNodeLlamaPackage).toHaveBeenCalledWith({
      app: join(tree.appOutDir, 'Metis.app'),
      platform: 'darwin-arm64',
      allowEvaluation: false
    })
  })

  it('removes the local tier from MAS without running the direct-package checker', async () => {
    const tree = await makePackageTree('mas')
    const localAi = join(tree.resourceDir, 'local-ai')
    const native = join(tree.resourceDir, 'app.asar.unpacked', 'node_modules', '@node-llama-cpp')
    await mkdir(localAi, { recursive: true })
    await mkdir(native, { recursive: true })
    await writeFile(join(localAi, 'manifest.json'), '{}')
    await writeFile(join(native, 'unexpected'), 'native')
    const checkNodeLlamaPackage = vi.fn()

    await afterPack(context('mas', 3, tree.appOutDir, tree.productFilename), {
      checkNodeLlamaPackage,
      execFileSync: vi.fn()
    })

    expect(checkNodeLlamaPackage).not.toHaveBeenCalled()
    expect(existsSync(localAi)).toBe(false)
    expect(existsSync(native)).toBe(false)
  })
})
