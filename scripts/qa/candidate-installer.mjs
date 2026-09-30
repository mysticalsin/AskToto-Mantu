// Selects the Windows Setup installer that a QA run may install: the one whose sha256 the lead named.
// The hosted Windows lane downloads candidate-win from a qa-candidate.yml run and installs only bytes
// that match; a differing or missing installer is an error, never a fallback to another file.
//   node scripts/qa/candidate-installer.mjs <dir> <sha256>   (prints the installer path)
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sha256File } from './provenance.mjs'

const SHA256 = /^[0-9a-f]{64}$/

export async function selectCandidateInstaller(dir, expectedSha256) {
  const expected = String(expectedSha256).trim().toLowerCase()
  if (!SHA256.test(expected)) throw new Error('sha256 must be 64 hexadecimal characters.')
  const setups = readdirSync(dir).filter((name) => /^Metis-Setup-.*\.exe$/.test(name))
  if (setups.length === 0) throw new Error(`No Metis-Setup-*.exe in ${dir}.`)
  const seen = []
  for (const name of setups.sort()) {
    const path = join(dir, name)
    const actual = await sha256File(path)
    if (actual === expected) return path
    seen.push(`${name} ${actual}`)
  }
  throw new Error(`No installer matches sha256 ${expected}; found ${seen.join(', ')}.`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [dir, sha256] = process.argv.slice(2)
  selectCandidateInstaller(dir, sha256).then(
    (path) => console.log(path),
    (error) => {
      console.error(`::error::${error.message}`)
      process.exit(1)
    }
  )
}
