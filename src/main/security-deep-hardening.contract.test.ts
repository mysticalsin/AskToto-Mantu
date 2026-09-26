import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Source-contract pins for the 2026-09-06 deep security pass (see .rocket-fuel/METIS-SECURITY-DEEP-RECEIPT.md).
 * Same technique as bank-grade-hardening.contract.test.ts: index.ts boots Electron and cannot be imported in
 * vitest, so each fix that lives there (or in a module whose behavior is only observable through Electron)
 * is pinned by the shape of its source. Behavioral proofs live next to each module's own test file.
 */
const root = join(__dirname, '..', '..')
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n')
const index = read('src/main/index.ts')

function sliceBetween(src: string, start: string, end: string): string {
  const a = src.indexOf(start)
  if (a === -1) throw new Error(`marker not found: ${start}`)
  const b = src.indexOf(end, a)
  if (b === -1) throw new Error(`end marker not found after start: ${end}`)
  return src.slice(a, b)
}

describe('board row 3 (PR148 line): Operator egress rides the guarded fetch', () => {
  it.each(['src/main/operator-ingest.ts', 'src/main/operator-overlay.ts'])('%s resolves fetch at call time, never at import', (file) => {
    const src = read(file)
    expect(src).not.toMatch(/let fetchImpl: typeof fetch = fetch\b/)
    expect(src).toMatch(/\(fetchOverride \?\? globalThis\.fetch\)\(input, init\)/)
  })

  it('the egress guard wraps node http/https and follows redirects itself', () => {
    const guard = read('src/main/net/egress-guard.ts')
    expect(guard).toMatch(/for \(const name of \['request', 'get'\] as const\)/)
    expect(guard).toMatch(/redirect: 'manual'/)
    expect(guard).toMatch(/MAX_REDIRECTS = 20/)
    expect(guard).toMatch(/CROSS_ORIGIN_STRIP = \['authorization', 'proxy-authorization', 'cookie'\]/)
  })
})

describe('board row 5 (Mantu Intelligence): nothing cloud-bound or synced skips redaction', () => {
  it('brainContext is redacted under the same switch as the transcript and the screen description', () => {
    const region = sliceBetween(index, 'const hit = buildBrainContext(s,', "req.mode === 'answer' && req.wantsScreenContext")
    expect(region).toMatch(/req\.brainContext = \(s\.redactSensitive && hit\.block \? redactSecrets\(hit\.block\) : hit\.block\) \|\| undefined/)
  })

  it('every wiki page goes through redactSecrets before the plaintext write', () => {
    const publish = read('src/main/brain/publish.ts')
    expect(publish).toMatch(/import \{ redactSecrets \} from '@shared\/redact'/)
    expect(publish).toMatch(/await writeSaved\(path, redactSecrets\(content\), false\)/)
    expect(publish).not.toMatch(/await writeSaved\(path, content, false\)/)
  })

  it('the graphify child gets the OS allow-list env, never the whole parent env', () => {
    const graphify = read('src/main/graphify.ts')
    expect(graphify).toMatch(/import \{ sanitizedSpawnEnv \} from '\.\/cli-installer'/)
    const def = sliceBetween(graphify, 'const spawnEnv = (extra', 'function execOpts')
    expect(def).toMatch(/\.\.\.sanitizedSpawnEnv\(\)/)
    expect(def).not.toMatch(/\.\.\.process\.env/)
  })

  it('the Intelligence sender check compares protocol, host and path', () => {
    const intel = read('src/main/intelligence.ts')
    expect(intel).toMatch(/cur\.protocol === own\.protocol && cur\.host === own\.host && cur\.pathname === own\.pathname/)
  })
})

describe('board row 1 (overlay line): every BrowserWindow denies navigation and popups', () => {
  it('the PDF export window has the same two guards as the overlay, decoder and Intelligence windows', () => {
    const region = sliceBetween(index, 'const pdfWin = new BrowserWindow({', 'pdfWin.destroy()')
    expect(region).toMatch(/pdfWin\.webContents\.setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/)
    expect(region).toMatch(/pdfWin\.webContents\.on\('will-navigate', \(e\) => e\.preventDefault\(\)\)/)
  })

  it('no window anywhere in src/main relaxes the sandbox', () => {
    for (const file of ['src/main/index.ts', 'src/main/intelligence.ts']) {
      const src = read(file)
      expect(src).not.toMatch(/nodeIntegration:\s*true/)
      expect(src).not.toMatch(/contextIsolation:\s*false/)
      expect(src).not.toMatch(/sandbox:\s*false/)
      expect(src).not.toMatch(/webSecurity:\s*false/)
    }
  })
})

describe('board row 6 (License + geo): the key never crosses the bridge; the lease is bound and revocable', () => {
  it('publicSettings blanks licenseKey and ships only hasLicenseKey', () => {
    const region = sliceBetween(index, 'function publicSettings(): PublicSettings {', 'visionReady:')
    expect(region).toMatch(/licenseKey: '',\s*\n\s*hasLicenseKey: !!s\.licenseKey/)
  })

  it('license.ts binds the lease to this machine and key, refuses a rolled-back clock, and drops it on revoke', () => {
    const license = read('src/main/license.ts')
    expect(license).toMatch(/lease\.machineId !== getMachineId\(\) \|\| lease\.licenseKey !== s\.licenseKey/)
    expect(license).toMatch(/now < s\.licenseLastValidatedAt \|\| now < lease\.issuedAt/)
    expect(license).toMatch(/setSettings\(\{ licenseValid: false, licenseLease: '' \}\)/)
    expect(license).not.toMatch(/u = `http:\/\/\$\{u\}`/)
  })
})

describe('board row 4 (Cloudflare key path): rotation writes the encrypted blob', () => {
  it('rotate-embedded-keys never writes a plaintext proxyKey file', () => {
    const script = read('scripts/rotate-embedded-keys.mjs')
    expect(script).toMatch(/import \{ encryptProxyKey \} from '\.\/lib\/embedded-cloudflare-crypto\.mjs'/)
    expect(script).toMatch(/JSON\.stringify\(encryptProxyKey\(key\), null, 2\)/)
    expect(script).not.toMatch(/JSON\.stringify\(\{ proxyKey: key \}/)
  })
})
