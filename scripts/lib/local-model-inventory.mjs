/** Exact immutable local-LLM payload verification; no network and no native signing exemptions. */
import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOCAL_MODEL_PAYLOAD } from '../local-model-assets.mjs'

/**
 * @param {string} root
 * @param {readonly {path: string, bytes: number, sha256: string}[]} expected
 * @param {{allowBuildGitkeep?: boolean}} options
 */
export async function verifyLocalModelPayload(
  root,
  expected = LOCAL_MODEL_PAYLOAD,
  { allowBuildGitkeep = false } = {}
) {
  const files = new Map()
  const directories = new Set([''])
  if (!Array.isArray(expected) || !expected.length) throw new Error('Local-model manifest is empty')
  for (const asset of expected) {
    const parts = typeof asset.path === 'string' ? asset.path.split('/') : []
    if (!parts.length || /[\\:]/.test(asset.path) || parts.some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`Unsafe local-model manifest path: ${asset.path}`)
    }
    if (files.has(asset.path) || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 ||
        !/^[a-f0-9]{64}$/.test(asset.sha256)) {
      throw new Error(`Invalid local-model manifest pin: ${asset.path}`)
    }
    files.set(asset.path, asset)
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'))
  }

  const found = new Set()
  function visit(relative = '') {
    const directory = join(root, relative)
    const stat = lstatSync(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Local-model payload needs a real directory, not a symlink: ${directory}`)
    }
    for (const name of readdirSync(directory)) {
      const path = relative ? `${relative}/${name}` : name
      const entry = lstatSync(join(root, path))
      if (entry.isSymbolicLink()) throw new Error(`Local-model payload contains a symlink: ${path}`)
      if (entry.isDirectory()) {
        if (!directories.has(path)) throw new Error(`Unexpected local-model directory: ${path}`)
        visit(path)
      } else if (entry.isFile()) {
        // Git can check out the tracked blank placeholder with LF or CRLF; installers never get it.
        if (allowBuildGitkeep && path === '.gitkeep' && entry.size <= 2 &&
            /^(?:\r?\n)?$/.test(readFileSync(join(root, path), 'utf8'))) continue
        const pin = files.get(path)
        if (!pin) throw new Error(`Unexpected local-model file: ${path}`)
        if (entry.size !== pin.bytes) {
          throw new Error(`${path}: expected ${pin.bytes} bytes, got ${entry.size}`)
        }
        found.add(path)
      } else {
        throw new Error(`Unexpected local-model special filesystem entry: ${path}`)
      }
    }
  }
  visit()
  for (const asset of expected) {
    if (!found.has(asset.path)) throw new Error(`Missing local-model asset: ${asset.path}`)
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(join(root, asset.path))) hash.update(chunk)
    const sha256 = hash.digest('hex')
    if (sha256 !== asset.sha256) {
      throw new Error(`${asset.path}: SHA-256 mismatch (expected ${asset.sha256}, got ${sha256})`)
    }
  }
  return expected
}
