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

describe('the release lane builds the lean profile (G11)', () => {
  const workflow = read('.github/workflows/qa-candidate.yml')

  it('builds every installer through the lean release plan and never through a full-profile dist chain', () => {
    expect(workflow).toMatch(/node scripts\/lean-release\.mjs mac "\$arch" \$\{\{ matrix\.flags \}\}/)
    expect(workflow).toMatch(/node scripts\/lean-release\.mjs win x64/)
    expect(workflow).not.toMatch(/npm run (dist|\$\{\{ matrix\.script \}\})/)
    expect(workflow).not.toMatch(/METIS_PACKAGE_PROFILE:\s*full/)
  })

  it('no longer restores or fetches the model and runtime cache a full package needed', () => {
    expect(workflow).not.toMatch(/runtime-assets-/)
    expect(workflow).not.toMatch(/resources\/(models|asr|ort|llama|local-llm)/)
  })

  it('builds both macOS architectures for the promotable variant and arm64 only for the QA identity', () => {
    expect(workflow).toMatch(/- variant: mac\r?\n\s+arches: arm64 x64\r?\n\s+flags: ''/)
    expect(workflow).toMatch(/- variant: mac-qa-identity\r?\n\s+arches: arm64\r?\n\s+flags: --qa-identity/)
  })

  it('passes the QA enrolment token only as secret and variable references', () => {
    expect(workflow).toContain('METIS_OPERATOR_ENROLL_TOKEN_QA: ${{ secrets.METIS_OPERATOR_ENROLL_TOKEN_QA }}')
    expect(workflow).not.toMatch(/METIS-ENR-1\./)
  })

  it('provenance expects one DMG and zip per macOS architecture and keeps the other asset names', () => {
    expect(VARIANTS.mac.assets('2.12.0')).toEqual([
      'Metis-2.12.0-arm64.dmg',
      'Metis-2.12.0-arm64.zip',
      'Metis-2.12.0-x64.dmg',
      'Metis-2.12.0-x64.zip'
    ])
    expect(VARIANTS['mac-qa-identity'].assets('2.12.0')).toEqual(['Metis-QA-2.12.0.zip'])
    expect(VARIANTS.win.assets('2.12.0')).toEqual(['Metis-Setup-2.12.0.exe'])
    expect(VARIANTS['win-portable'].assets('2.12.0')).toEqual(['Metis-Portable-2.12.0.exe'])
  })

  it('launches only the installer that matches the Apple Silicon runner and says why the Intel one is not', () => {
    expect(workflow).toMatch(/\*-x64\.\*\) echo "::notice::\$name targets Intel/)
    expect(workflow).toMatch(/case "\$name" in \*-x64\.\*\) continue ;; esac/)
  })

  it('selects the arm64 DMG wherever a single DMG was assumed', () => {
    expect(workflow).toContain("find assets-mac -maxdepth 1 -name '*-arm64.dmg'")
    expect(workflow).toContain('dmgs=(assets/*-arm64.dmg)')
  })

  it('exposes the lean chain as an npm script that does not run from the full-profile chains', () => {
    expect(scripts['dist:lean']).toBe('node scripts/lean-release.mjs')
    for (const legacy of ['dist', 'dist:local', 'dist:win', 'dist:qa-identity']) {
      expect(scripts[legacy], legacy).not.toContain('lean-release')
    }
  })
})
