import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { provisionManagedNodeArchive } from './lib/managed-node-provision.mjs'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(includeNode = true) {
  const root = mkdtempSync(join(tmpdir(), 'metis-provision-node-'))
  scratch.push(root)
  const file = 'node-v24.21.0-darwin-arm64.tar.gz'
  const inner = file.replace(/\.tar\.gz$/, '')
  const source = join(root, inner)
  mkdirSync(join(source, 'bin'), { recursive: true })
  writeFileSync(join(source, 'LICENSE'), 'fixture license')
  if (includeNode) writeFileSync(join(source, 'bin', 'node'), 'new binary fixture')
  const archive = join(root, file)
  execFileSync('tar', ['-czf', archive, '-C', root, inner])
  const dest = join(root, 'resources', 'managed-node', 'darwin-arm64')
  mkdirSync(join(dest, 'lib', 'node_modules', 'corepack'), { recursive: true })
  writeFileSync(join(dest, '.gitkeep'), '')
  writeFileSync(join(dest, 'lib', 'node_modules', 'corepack', 'removed-in-new-runtime.js'), 'old')
  writeFileSync(join(dest, '.node-version'), '22.22.3\n')
  return {
    root, archive, dest,
    spec: {
      file,
      sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
      nodeRelPath: 'bin/node'
    }
  }
}

describe('MQA-314: managed Node provisioning', () => {
  it('promotes a verified complete archive, removing files from the previous Node release', () => {
    const { archive, dest, spec } = fixture()
    provisionManagedNodeArchive(archive, dest, spec, '24.21.0')
    expect(readFileSync(join(dest, 'bin', 'node'), 'utf8')).toBe('new binary fixture')
    expect(readFileSync(join(dest, '.node-version'), 'utf8')).toBe('24.21.0\n')
    expect(existsSync(join(dest, 'lib', 'node_modules', 'corepack'))).toBe(false)
    expect(readFileSync(join(dest, '.gitkeep'), 'utf8')).toBe('')
    expect(readdirSync(dirname(dest))).toEqual(['darwin-arm64'])
  })

  it('rejects an archive hash mismatch without modifying the previous runtime', () => {
    const { archive, dest, spec } = fixture()
    expect(() => provisionManagedNodeArchive(archive, dest, { ...spec, sha256: '0'.repeat(64) }, '24.21.0'))
      .toThrow(/sha256/)
    expect(readFileSync(join(dest, '.node-version'), 'utf8')).toBe('22.22.3\n')
    expect(readdirSync(dirname(dest))).toEqual(['darwin-arm64'])
  })

  it('does not promote or stamp an archive missing its actual node binary', () => {
    const { archive, dest, spec } = fixture(false)
    expect(() => provisionManagedNodeArchive(archive, dest, spec, '24.21.0')).toThrow(/node binary/)
    expect(readFileSync(join(dest, '.node-version'), 'utf8')).toBe('22.22.3\n')
    expect(readdirSync(dirname(dest))).toEqual(['darwin-arm64'])
  })
})
