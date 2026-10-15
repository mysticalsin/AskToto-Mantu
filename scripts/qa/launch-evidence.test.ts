import { describe, expect, it } from 'vitest'
import { evidenceFromLaunchReports } from './launch-evidence.mjs'
import { promotableAssets } from './provenance.mjs'

const provenance = {
  version: '1.9.7',
  run: { id: 4242 },
  builds: [
    {
      variant: 'mac',
      assets: [
        { name: 'Metis-1.9.7.dmg', sha256: 'a'.repeat(64) },
        { name: 'Metis-1.9.7.zip', sha256: 'b'.repeat(64) }
      ]
    },
    {
      variant: 'mac-qa-identity',
      assets: [{ name: 'Metis-QA-1.9.7.zip', sha256: 'c'.repeat(64) }]
    },
    {
      variant: 'win',
      assets: [{ name: 'Metis-Setup-1.9.7.exe', sha256: 'd'.repeat(64) }]
    }
  ]
}

function report(asset: { name: string; sha256: string }, overrides: Record<string, unknown> = {}) {
  return {
    installer: asset.name,
    artifact_sha256: asset.sha256,
    candidate_run: 4242,
    verdict: 'PASS',
    ...overrides
  }
}

describe('launch evidence', () => {
  it('writes one PASS line per promotable installer and ignores the QA identity build', () => {
    const assets = promotableAssets(provenance) as Array<{ name: string; sha256: string }>
    const { lines, problems } = evidenceFromLaunchReports(
      provenance,
      assets.map((asset) => report(asset)).concat([report({ name: 'Metis-QA-1.9.7.zip', sha256: 'c'.repeat(64) })])
    )
    expect(problems).toEqual([])
    expect(lines).toHaveLength(3)
    for (const [index, asset] of assets.entries()) {
      expect(JSON.parse(lines[index])).toEqual({
        ticket: 'M2-0187',
        result: 'PASS',
        build_run_id: 4242,
        artifact_sha256: asset.sha256
      })
    }
  })

  it('refuses a promotable installer with no matching PASS report', () => {
    const assets = promotableAssets(provenance) as Array<{ name: string; sha256: string }>
    const { lines, problems } = evidenceFromLaunchReports(provenance, [report(assets[0], { verdict: 'FAIL' })])
    expect(lines).toEqual([])
    expect(problems.some((problem) => problem.includes('Metis-1.9.7.dmg launch verdict is FAIL'))).toBe(true)
    expect(problems.some((problem) => problem.includes('no launch report for Metis-1.9.7.zip'))).toBe(true)
  })

  it('refuses a report bound to a different candidate run', () => {
    const assets = promotableAssets(provenance) as Array<{ name: string; sha256: string }>
    const { problems } = evidenceFromLaunchReports(
      provenance,
      assets.map((asset) => report(asset, { candidate_run: 1 }))
    )
    expect(problems.every((problem) => problem.includes('bound to run 1'))).toBe(true)
  })
})
