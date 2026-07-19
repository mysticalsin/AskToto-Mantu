import { createHash } from 'node:crypto'
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveSelectedTextModel } from './model-manifest'

const bytes = Buffer.from('tiny gguf fixture')
const sha256 = createHash('sha256').update(bytes).digest('hex')

describe('resolveSelectedTextModel', () => {
  let appPath: string
  let root: string
  const context = () => ({ isPackaged: false, resourcesPath: '/unused', appPath })

  beforeEach(() => {
    appPath = mkdtempSync(join(tmpdir(), 'metis-model-manifest-'))
    root = join(appPath, 'resources', 'local-ai', 'payload')
    mkdirSync(join(root, 'text', 'qwen'), { recursive: true })
    writeFileSync(join(root, 'text', 'qwen', 'model.gguf'), bytes)
    writeManifest()
  })

  afterEach(() => {
    rmSync(appPath, { recursive: true, force: true })
  })

  function manifest() {
    return {
      schemaVersion: 1,
      targetPlatform: 'darwin-arm64',
      approval: 'evaluation',
      selected: {
        text: { id: 'qwen', model: 'qwen3-0.6b', precision: 'Q8_0', runtime: 'node-llama-cpp' },
        vision: { id: 'vision', model: 'smolvlm', precision: 'Q8', runtime: 'transformers.js' }
      },
      assets: [
        {
          id: 'qwen-weights',
          variantId: 'qwen',
          component: 'weights',
          destination: 'text/qwen/model.gguf',
          bytes: bytes.length,
          sha256
        }
      ]
    }
  }

  function writeManifest(value = manifest()): void {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'manifest.json'), `${JSON.stringify(value)}\n`)
  }

  it('returns the one selected, verified, real GGUF path', async () => {
    await expect(
      resolveSelectedTextModel({ context: context(), targetPlatform: 'darwin-arm64' })
    ).resolves.toEqual({
      id: 'qwen',
      sha256,
      absolutePath: realpathSync(join(root, 'text', 'qwen', 'model.gguf'))
    })
  })

  it('rejects a platform or runtime mismatch', async () => {
    await expect(
      resolveSelectedTextModel({ context: context(), targetPlatform: 'win32-x64' })
    ).rejects.toThrow(/platform/i)
    const value = manifest()
    value.selected.text.runtime = 'transformers.js'
    writeManifest(value)
    await expect(
      resolveSelectedTextModel({ context: context(), targetPlatform: 'darwin-arm64' })
    ).rejects.toThrow(/runtime/i)
  })

  it('rejects zero or multiple selected weight assets', async () => {
    const value = manifest()
    value.assets = []
    writeManifest(value)
    await expect(
      resolveSelectedTextModel({ context: context(), targetPlatform: 'darwin-arm64' })
    ).rejects.toThrow(/one selected/i)
    value.assets = [manifest().assets[0], { ...manifest().assets[0], id: 'duplicate' }]
    writeManifest(value)
    await expect(
      resolveSelectedTextModel({ context: context(), targetPlatform: 'darwin-arm64' })
    ).rejects.toThrow(/one selected/i)
  })

  it('rejects traversal, size changes, and hash changes', async () => {
    const value = manifest()
    value.assets[0].destination = '../model.gguf'
    writeManifest(value)
    await expect(
      resolveSelectedTextModel({ context: context(), targetPlatform: 'darwin-arm64' })
    ).rejects.toThrow()

    value.assets[0].destination = 'text/qwen/model.gguf'
    value.assets[0].bytes += 1
    writeManifest(value)
    await expect(
      resolveSelectedTextModel({ context: context(), targetPlatform: 'darwin-arm64' })
    ).rejects.toThrow(/size/i)

    value.assets[0].bytes = bytes.length
    value.assets[0].sha256 = 'b'.repeat(64)
    writeManifest(value)
    await expect(
      resolveSelectedTextModel({ context: context(), targetPlatform: 'darwin-arm64' })
    ).rejects.toThrow(/hash/i)
  })

  it('rejects symlinked and hardlinked model files', async () => {
    const modelPath = join(root, 'text', 'qwen', 'model.gguf')
    const symlinkTarget = join(appPath, 'outside.gguf')
    writeFileSync(symlinkTarget, bytes)
    rmSync(modelPath)
    symlinkSync(symlinkTarget, modelPath)
    await expect(
      resolveSelectedTextModel({ context: context(), targetPlatform: 'darwin-arm64' })
    ).rejects.toThrow(/regular/i)

    rmSync(modelPath)
    linkSync(symlinkTarget, modelPath)
    expect(dirname(modelPath)).toContain(root)
    await expect(
      resolveSelectedTextModel({ context: context(), targetPlatform: 'darwin-arm64' })
    ).rejects.toThrow(/hardlink/i)
  })
})
