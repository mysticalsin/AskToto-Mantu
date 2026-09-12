import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyLocalModelPayload } from './lib/local-model-inventory.mjs'

const directories: string[] = []
const license = 'LICENSE.QWEN3.5-APACHE-2.0.txt'
const modelDir = 'models/qwen3.5-0.8b'
const names = [license, `${modelDir}/model.gguf`, `${modelDir}/mmproj.gguf`]
const digest = (data: string): string => createHash('sha256').update(data).digest('hex')

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'metis-model-inventory-'))
  directories.push(base)
  const root = join(base, 'local-llm')
  const expected = names.map((path, index) => {
    const data = `synthetic immutable payload ${index}`
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), data)
    return { path, bytes: Buffer.byteLength(data), sha256: digest(data) }
  })
  return { root, expected }
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('MQA-319: immutable local-model package verification', () => {
  it('accepts the complete exact inventory and verifies every small fixture against real hashes', async () => {
    const { root, expected } = fixture()
    await expect(verifyLocalModelPayload(root, expected)).resolves.toEqual(expected)
  })

  it.each(names)('rejects a package missing %s', async (path) => {
    const { root, expected } = fixture()
    rmSync(join(root, path))
    await expect(verifyLocalModelPayload(root, expected)).rejects.toThrow(/Missing local-model asset/)
  })

  it.each(names)('rejects same-length corruption of %s', async (path) => {
    const { root, expected } = fixture()
    const pin = expected.find((entry) => entry.path === path)!
    writeFileSync(join(root, path), Buffer.alloc(pin.bytes, 65))
    await expect(verifyLocalModelPayload(root, expected)).rejects.toThrow(/SHA-256 mismatch/)
  })

  it('rejects a truncated model before hashing it', async () => {
    const { root, expected } = fixture()
    writeFileSync(join(root, modelDir, 'model.gguf'), 'short')
    await expect(verifyLocalModelPayload(root, expected)).rejects.toThrow(/expected .* bytes, got 5/)
  })

  it.each(['.DS_Store', '.gitkeep', `${modelDir}/model.gguf.part`, 'models/qwen3.5-4b/model.gguf'])(
    'rejects unreviewed packaged payload %s',
    async (path) => {
      const { root, expected } = fixture()
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), '')
      await expect(verifyLocalModelPayload(root, expected)).rejects.toThrow(/Unexpected local-model/)
    }
  )

  it('rejects empty unexpected directories rather than only scanning files', async () => {
    const { root, expected } = fixture()
    mkdirSync(join(root, modelDir, '.cache'))
    await expect(verifyLocalModelPayload(root, expected)).rejects.toThrow(/Unexpected local-model directory/)
  })

  it.each(['', modelDir])('rejects a symlink/junction replacing the model directory %s', async (relative) => {
    const { root, expected } = fixture()
    const original = join(root, relative)
    const moved = join(dirname(root), 'external')
    renameSync(original, moved)
    symlinkSync(moved, original, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(verifyLocalModelPayload(root, expected)).rejects.toThrow(/real directory|symlink/)
  })

  it.each(['', '\n', '\r\n'])('allows the tracked blank root placeholder %j only for build inputs', async (placeholder) => {
    const { root, expected } = fixture()
    writeFileSync(join(root, '.gitkeep'), placeholder)
    await expect(verifyLocalModelPayload(root, expected, { allowBuildGitkeep: true })).resolves.toEqual(expected)
  })

  it.each(['A', '\0', ' \n', 'unreviewed content'])('rejects nonblank placeholder content %j even in build inputs', async (content) => {
    const { root, expected } = fixture()
    writeFileSync(join(root, '.gitkeep'), content)
    await expect(verifyLocalModelPayload(root, expected, { allowBuildGitkeep: true })).rejects.toThrow(/Unexpected local-model/)
  })

  it('rejects unsafe manifest paths before opening anything outside the model root', async () => {
    const { root, expected } = fixture()
    await expect(verifyLocalModelPayload(root, [{ ...expected[0], path: '../outside' }])).rejects.toThrow(/Unsafe local-model manifest path/)
  })
})
