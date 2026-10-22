import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = join(__dirname, '..')
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8')
const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>

describe('Operator enrolment token wiring (O11)', () => {
  for (const name of ['dist', 'dist:qa-identity', 'dist:local', 'dist:win']) {
    it(`${name} embeds the token before packaging and checks the package after`, () => {
      const cmd = scripts[name]
      const embed = cmd.indexOf('scripts/embed-operator-enroll-token.mjs')
      const pack = cmd.indexOf('electron-builder')
      const check = cmd.indexOf('scripts/check-embedded-operator-enroll.mjs')
      expect(embed).toBeGreaterThanOrEqual(0)
      expect(embed).toBeLessThan(pack)
      expect(check).toBeGreaterThan(pack)
    })
  }

  it('only the QA identity build uses the QA token variables', () => {
    expect(scripts['dist:qa-identity']).toContain('scripts/embed-operator-enroll-token.mjs --qa')
    for (const name of ['dist', 'dist:local', 'dist:win']) expect(scripts[name]).not.toContain('--qa')
  })

  it('electron-builder packages the blob next to the Cloudflare one, and git ignores everything but .gitkeep', () => {
    expect(read('electron-builder.yml')).toMatch(/- from: build\/operator-embed\n\s+to: operator-embed/)
    const ignore = read('.gitignore')
    expect(ignore).toContain('build/operator-embed/*')
    expect(ignore).toContain('!build/operator-embed/.gitkeep')
  })

  it('release.yml passes the token only as secret and variable references and never a literal', () => {
    const wf = read('.github/workflows/release.yml')
    expect(wf).toContain('METIS_OPERATOR_ENROLL_TOKEN: ${{ secrets.METIS_OPERATOR_ENROLL_TOKEN }}')
    expect(wf).toContain('METIS_OPERATOR_ENROLL_REQUIRED: ${{ vars.METIS_OPERATOR_ENROLL_REQUIRED }}')
    expect(wf).not.toMatch(/METIS-ENR-1\./)
    // both platform builds and the mac secret gate
    expect(wf.match(/METIS_OPERATOR_ENROLL_TOKEN: \$\{\{ secrets\.METIS_OPERATOR_ENROLL_TOKEN \}\}/g)).toHaveLength(3)
  })

  it('the QA lane maps the QA token for dist:qa-identity', () => {
    const wf = read('.github/workflows/qa-candidate.yml')
    expect(wf).toContain('METIS_OPERATOR_ENROLL_TOKEN_QA: ${{ secrets.METIS_OPERATOR_ENROLL_TOKEN_QA }}')
    expect(wf).not.toMatch(/METIS-ENR-1\./)
  })
})
