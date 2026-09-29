import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = join(__dirname, '..', '..', '..', '..', '..')
const OWN = join('src', 'main', 'features', 'components', 'speech-pack') + sep
const SKIP = new Set(['node_modules', 'out', 'dist', '.git', 'release'])

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
  it('no source file elsewhere imports, requires or dynamically imports it', () => {
    const importer = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"][^'"]*speech-pack[^'"]*['"]/
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
        if (importer.test(readFileSync(file, 'utf8'))) offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })
})
