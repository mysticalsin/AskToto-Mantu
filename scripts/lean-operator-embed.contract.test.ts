import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VARIANTS } from './qa/provenance.mjs'

const REPO = join(__dirname, '..')
const read = (path: string): string => readFileSync(join(REPO, path), 'utf8')
const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>

describe('lean staging carries the Operator enrolment blob, guarded like every other chain (G11, O11)', () => {
  it('stages build/operator-embed into the lean resources next to the Cloudflare blob', () => {
    expect(read('scripts/prepare-lean-package-stage.mjs')).toMatch(
      /copyTree\('build\/cloudflare-embed', 'cloudflare-embed'\)[\s\S]*copyTree\('build\/operator-embed', 'operator-embed'\)/
    )
  })

  it('requires the operator-embed directory in a lean package, empty or holding the blob', () => {
    expect(read('scripts/check-lean-package.mjs')).toMatch(/'operator-embed',\r?\n\s+'license-lease'/)
  })

  it('electron-builder.yml no longer says the lean profile never carries the blob', () => {
    expect(read('electron-builder.yml')).not.toMatch(
      /lean package profile stages its own resources and never carries it/
    )
    expect(read('electron-builder.yml')).toMatch(/- from: build\/operator-embed\r?\n\s+to: operator-embed/)
  })

  it('the lean-candidates lane clears the blob before building and checks the package after, with no token', () => {
    const workflow = read('.github/workflows/lean-candidates.yml')
    expect(workflow).toMatch(/node scripts\/embed-operator-enroll-token\.mjs\r?\n/)
    expect(workflow).toMatch(/node scripts\/check-embedded-operator-enroll\.mjs "\$dir"/)
    expect(workflow).not.toMatch(/METIS_OPERATOR_ENROLL_TOKEN/)
    expect(workflow).not.toMatch(/METIS-ENR-1\./)
  })
})

describe('the release lane builds full by default and lean on request (G11)', () => {
  const workflow = read('.github/workflows/qa-candidate.yml')

  it('has a profile dispatch input whose default is full', () => {
    expect(workflow).toMatch(
      /\n {6}profile:\r?\n(?: {8}.*\r?\n)*? {8}default: full\r?\n(?: {8}.*\r?\n)*? {8}type: choice\r?\n {8}options:\r?\n {10}- full\r?\n {10}- lean/
    )
    // A pull request self-test has no inputs, so the empty value must resolve to full.
    expect(workflow).toContain("METIS_CANDIDATE_PROFILE: ${{ inputs.profile || 'full' }}")
  })

  it('keeps the full build steps for everything except an explicit lean dispatch', () => {
    expect(workflow).toMatch(
      /- name: Build the \$\{\{ matrix\.variant \}\} installers\r?\n {8}if: inputs\.profile != 'lean'\r?\n {8}run: npm run \$\{\{ matrix\.script \}\}/
    )
    expect(workflow).toMatch(
      /- name: Build the win installers\r?\n {8}if: inputs\.profile != 'lean'\r?\n {8}run: npm run dist:win/
    )
    expect(workflow).toMatch(/if: inputs\.profile != 'lean'\r?\n {8}with:\r?\n {10}path: \|\r?\n {12}resources\/models/)
    expect(workflow).toContain('script: dist\n')
    expect(workflow).toContain('script: dist:qa-identity')
  })

  it('runs the lean plan only when lean is requested', () => {
    expect(workflow).toMatch(
      /if: inputs\.profile == 'lean'\r?\n {8}run: \|\r?\n {10}for arch in \$\{\{ matrix\.arches \}\}; do\r?\n {12}node scripts\/lean-release\.mjs mac "\$arch" \$\{\{ matrix\.flags \}\}/
    )
    expect(workflow).toMatch(/if: inputs\.profile == 'lean'\r?\n {8}run: node scripts\/lean-release\.mjs win x64/)
    expect(workflow).toMatch(/- variant: mac\r?\n\s+script: dist\r?\n\s+arches: arm64 x64\r?\n\s+flags: ''/)
    expect(workflow).toMatch(
      /- variant: mac-qa-identity\r?\n\s+script: dist:qa-identity\r?\n\s+arches: arm64\r?\n\s+flags: --qa-identity/
    )
    expect(workflow).not.toMatch(/METIS_PACKAGE_PROFILE:\s*full/)
  })

  it('passes the QA enrolment token only as secret and variable references', () => {
    expect(workflow).toContain('METIS_OPERATOR_ENROLL_TOKEN_QA: ${{ secrets.METIS_OPERATOR_ENROLL_TOKEN_QA }}')
    expect(workflow).not.toMatch(/METIS-ENR-1\./)
  })

  it('provenance defaults to the full asset names and expects one DMG and zip per architecture for lean', () => {
    expect(VARIANTS.mac.assets('2.12.0')).toEqual(['Metis-2.12.0.dmg', 'Metis-2.12.0.zip'])
    expect(VARIANTS.mac.assets('2.12.0', 'full')).toEqual(['Metis-2.12.0.dmg', 'Metis-2.12.0.zip'])
    expect(VARIANTS.mac.assets('2.12.0', 'lean')).toEqual([
      'Metis-2.12.0-arm64.dmg',
      'Metis-2.12.0-arm64.zip',
      'Metis-2.12.0-x64.dmg',
      'Metis-2.12.0-x64.zip'
    ])
    // Only the macOS variant depends on the profile; the other variants' names are profile-independent.
    expect(VARIANTS['mac-qa-identity'].assets('2.12.0')).toEqual(['Metis-QA-2.12.0.zip'])
    expect(VARIANTS.win.assets('2.12.0')).toEqual(['Metis-Setup-2.12.0.exe'])
    expect(VARIANTS['win-portable'].assets('2.12.0')).toEqual(['Metis-Portable-2.12.0.exe'])
  })

  it('launches no Intel installer on the Apple Silicon runner; the skip cannot match a full asset name', () => {
    expect(workflow).toMatch(/\*-x64\.\*\) echo "::notice::\$name targets Intel/)
    expect(workflow).toMatch(/case "\$name" in \*-x64\.\*\) continue ;; esac/)
    for (const name of ['Metis-2.12.0.dmg', 'Metis-2.12.0.zip', 'Metis-QA-2.12.0.zip'])
      expect(name).not.toMatch(/-x64\./)
  })

  it('selects the arm64 DMG when there are two and the single DMG otherwise', () => {
    expect(workflow).toContain("find assets-mac -maxdepth 1 -name '*-arm64.dmg'")
    expect(workflow).toContain('[ -n "$dmg" ] || dmg=$(find assets-mac -maxdepth 1 -name \'*.dmg\' -print -quit)')
    expect(workflow).toContain('dmgs=(assets/*-arm64.dmg)')
    expect(workflow).toContain('[ -e "${dmgs[0]}" ] || dmgs=(assets/*.dmg)')
  })

  it('exposes the lean chain as an npm script that does not run from the full-profile chains', () => {
    expect(scripts['dist:lean']).toBe('node scripts/lean-release.mjs')
    for (const legacy of ['dist', 'dist:local', 'dist:win', 'dist:qa-identity']) {
      expect(scripts[legacy], legacy).not.toContain('lean-release')
    }
  })
})
