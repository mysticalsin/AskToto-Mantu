import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// Architecture rule: the OS credential store (Electron's safeStorage) is reached only through
// infra/secrets, so a crypto or durability fix is made once. Comments may still name it; code may not
// import it. The rule is about imports because that is the only way to obtain it.
const SRC = join(__dirname, '..', '..', '..')
const ALLOWED_DIR = join(SRC, 'main', 'infra', 'secrets') + sep

const IMPORTS_SAFE_STORAGE = [
  /import\s*(?:type\s*)?\{[^}]*\bsafeStorage\b[^}]*\}\s*from\s*['"]electron['"]/,
  /\bsafeStorage\s*\}?\s*=\s*require\(\s*['"]electron['"]\s*\)/,
  /\belectron\.safeStorage\b/
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('safeStorage boundary', () => {
  it('is imported only under src/main/infra/secrets', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.startsWith(ALLOWED_DIR))
      .filter((file) => IMPORTS_SAFE_STORAGE.some((rule) => rule.test(readFileSync(file, 'utf8'))))
      .map((file) => relative(SRC, file))
    expect(offenders).toEqual([])
  })

  it('finds the one legitimate importer, so the scan cannot pass by matching nothing', () => {
    const importers = sourceFiles(SRC)
      .filter((file) => IMPORTS_SAFE_STORAGE.some((rule) => rule.test(readFileSync(file, 'utf8'))))
      .map((file) => relative(SRC, file).split(sep).join('/').replace(/\.ts$/, ''))
    expect(importers).toEqual(['main/infra/secrets/keychain'])
  })
})
