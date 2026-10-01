// Selects the installer that a QA run may install: the one whose sha256 the lead named. Hosted lanes
// download a qa-candidate.yml artifact (candidate-win, candidate-mac or candidate-mac-qa-identity) and
// install only bytes that match; a differing or missing installer is an error, never a fallback to
// another file.
//   node scripts/qa/candidate-installer.mjs <dir> <sha256> [win|mac]   (prints the installer path)
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sha256File } from './provenance.mjs'

const SHA256 = /^[0-9a-f]{64}$/

/** The installer files each platform may select from. Windows installs only the Setup, never the Portable. */
export const INSTALLER_KINDS = Object.freeze({
  win: Object.freeze({ label: 'Metis-Setup-*.exe', pattern: /^Metis-Setup-.*\.exe$/ }),
  mac: Object.freeze({ label: '*.dmg or *.zip', pattern: /\.(dmg|zip)$/ }),
  'mac-dmg': Object.freeze({ label: 'Metis-*.dmg', pattern: /^Metis-.*\.dmg$/ })
})

export async function selectCandidateInstaller(dir, expectedSha256, platform = 'win') {
  const kind = INSTALLER_KINDS[platform]
  if (!kind) throw new Error(`Unknown installer platform ${platform}; expected ${Object.keys(INSTALLER_KINDS).join(' or ')}.`)
  const expected = String(expectedSha256).trim().toLowerCase()
  if (!SHA256.test(expected)) throw new Error('sha256 must be 64 hexadecimal characters.')
  const installers = readdirSync(dir).filter((name) => kind.pattern.test(name))
  if (installers.length === 0) throw new Error(`No ${kind.label} in ${dir}.`)
  const seen = []
  for (const name of installers.sort()) {
    const path = join(dir, name)
    const actual = await sha256File(path)
    if (actual === expected) return path
    seen.push(`${name} ${actual}`)
  }
  throw new Error(`No installer matches sha256 ${expected}; found ${seen.join(', ')}.`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [dir, sha256, platform] = process.argv.slice(2)
  selectCandidateInstaller(dir, sha256, platform).then(
    (path) => console.log(path),
    (error) => {
      console.error(`::error::${error.message}`)
      process.exit(1)
    }
  )
}
