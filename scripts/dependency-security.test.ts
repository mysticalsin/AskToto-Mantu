import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DOMPURIFY_STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

it('MQA-303 does not restore vulnerable networking libraries bundled in the old Dust client', () => {
  const lock = JSON.parse(readFileSync(join(__dirname, '..', 'package-lock.json'), 'utf8'))
  expect(lock.packages['node_modules/@dust-tt/client'].version).not.toBe('1.2.6')
  expect(lock.packages['node_modules/@dust-tt/client/node_modules/express-rate-limit']).toBeUndefined()
  expect(lock.packages['node_modules/@dust-tt/client/node_modules/ip-address']).toBeUndefined()
})

it('keeps every locked DOMPurify copy at or above the CI advisory floor', () => {
  const lock = JSON.parse(readFileSync(join(__dirname, '..', 'package-lock.json'), 'utf8')) as {
    packages?: Record<string, { version?: unknown }>
  }
  const entries = Object.entries(lock.packages ?? {}).filter(
    ([path]) => path === 'node_modules/dompurify' || path.endsWith('/node_modules/dompurify')
  )
  expect(entries.length).toBeGreaterThan(0)

  // The CI advisory set requires stable DOMPurify 3.4.17 or later (GHSA-p98j-92pf-mc4p,
  // GHSA-6688-9rhm-gjv2, GHSA-cg2g-xh64-v4q7, GHSA-mrv2-3pqr-j5jr, GHSA-c6gr-qvv4-5v3f).
  for (const [path, pkg] of entries) {
    const version = pkg?.version
    expect(typeof version, `${path} has a resolved version`).toBe('string')
    if (typeof version !== 'string') continue

    const match = DOMPURIFY_STABLE_VERSION.exec(version)
    expect(match, `${path} has a stable numeric three-part version`).not.toBeNull()
    if (!match) continue
    expect(match[0], `${path} version has no trailing characters`).toBe(version)

    const [major, minor, patch] = match.slice(1, 4).map(Number)
    expect([major, minor, patch].every(Number.isSafeInteger), `${path} version components are safe integers`).toBe(true)
    expect(
      major > 3 || (major === 3 && (minor > 4 || (minor === 4 && patch >= 17))),
      `${path} resolved ${version} meets 3.4.17+`
    ).toBe(true)
  }
})
