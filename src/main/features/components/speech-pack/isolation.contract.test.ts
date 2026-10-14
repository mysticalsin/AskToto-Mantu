import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = join(__dirname, '..', '..', '..', '..', '..')
const OWN = join('src', 'main', 'features', 'components', 'speech-pack') + sep
const SKIP = new Set(['node_modules', 'out', 'dist', '.git', 'release'])
const IMPORT_SPECIFIER = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g

function importsSpeechPackModule(source: string): boolean {
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1]
    const segments = specifier.split('/')
    if (segments.includes('speech-pack')) return true
  }
  return false
}

function sources(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sources(abs))
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) found.push(abs)
  }
  return found
}

describe('M2-0475 — the speech-pack module is imported by nothing outside its folder', () => {
  it('matches module-folder imports without flagging speech-pack in another filename', () => {
    expect(importsSpeechPackModule("import { policy } from '../lib/local-speech-pack-policy'")).toBe(false)
    expect(importsSpeechPackModule("import { engine } from '../features/components/speech-pack'")).toBe(true)
    expect(importsSpeechPackModule("import('./features/components/speech-pack/engine')")).toBe(true)
  })

  it('no source file elsewhere imports, requires or dynamically imports it', () => {
    const offenders: string[] = []
    for (const top of ['src', 'scripts', 'operator', 'cloudflare-proxy', 'license-server', 'intelligence']) {
      let files: string[] = []
      try {
        files = sources(join(REPO, top))
      } catch {
        continue
      }
      for (const file of files) {
        const rel = relative(REPO, file)
        if (rel.startsWith(OWN)) continue
        if (importsSpeechPackModule(readFileSync(file, 'utf8'))) offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })
})
