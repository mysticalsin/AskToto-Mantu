/**
 * license-enforcement-drift.contract.test.ts — MQA-068.
 *
 * Device licensing is COMPILED OFF: `LICENSE_ENFORCEMENT` (App.tsx) makes the <LicenseGate/> branch
 * unreachable and `LICENSE_UI_ENABLED` (Settings.tsx) hides the only activation form, so `licenseValid`
 * can never be set and main's revocation heartbeat — gated on `licenseGateEnabled && licenseValid` —
 * can never run. That is a deliberate state (the public license-server deploy is still open, see
 * docs/license-platform-plan.md Phase 2).
 *
 * The defect was not the off-switch. It was that a SHIPPED artifact and four docs went on asserting
 * enforcement that could not occur: build/managed-config.enterprise.example.json set AND locked
 * `licenseGateEnabled: true`, and docs/ENTERPRISE_RELEASE.md listed "a fresh install blocks when
 * licenseGateEnabled is true" as a pre-ship proof — a proof that can never pass, and therefore one that
 * gets ticked off. Root cause was commit 596c17a, which flipped the constant and updated nothing else.
 *
 * So this file pins the RELATIONSHIP rather than any one file: while enforcement is compiled off, no
 * artifact may claim otherwise. Flip the two constants and these tests demand the artifacts move with
 * them — which is exactly the coupling that was missing.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO = join(__dirname, '..', '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8').replace(/\r\n/g, '\n')

const appSrc = read('src/renderer/src/App.tsx')
const settingsSrc = read('src/renderer/src/components/Settings.tsx')

/** The single source of truth every assertion below keys off. */
const enforcementCompiledOff =
  /const LICENSE_ENFORCEMENT = false/.test(appSrc) && /const LICENSE_UI_ENABLED: boolean = false/.test(settingsSrc)

describe('MQA-068 — no artifact may advertise licensing that cannot run', () => {
  it('reads both switches, so a rename fails loudly instead of silently passing', () => {
    expect(appSrc).toMatch(/const LICENSE_ENFORCEMENT = (true|false)/)
    expect(settingsSrc).toMatch(/const LICENSE_UI_ENABLED: boolean = (true|false)/)
  })

  it('the two switches agree with each other — one on and one off is the brick state', () => {
    const gateOn = /const LICENSE_ENFORCEMENT = true/.test(appSrc)
    const formOn = /const LICENSE_UI_ENABLED: boolean = true/.test(settingsSrc)
    expect(gateOn).toBe(formOn)
  })

  it('the shipped enterprise policy does not set a key that activates nothing', () => {
    const example = read('build/managed-config.enterprise.example.json')
    const policy = JSON.parse(example) as { locked?: string[]; licenseGateEnabled?: boolean }
    if (enforcementCompiledOff) {
      expect(policy.licenseGateEnabled).toBeUndefined()
      expect(policy.locked ?? []).not.toContain('licenseGateEnabled')
      // ...and says why, so the next person does not "helpfully" add it back.
      expect(example).toContain('MQA-068')
    } else {
      expect(policy.licenseGateEnabled).toBe(true)
    }
  })

  it('the release checklist does not carry a licensing proof that can never pass', () => {
    const release = read('docs/ENTERPRISE_RELEASE.md')
    const proof = release.slice(release.indexOf('## Customer Control Proof'), release.indexOf('## Store Caveat'))
    if (enforcementCompiledOff) {
      expect(proof).not.toMatch(/A fresh install blocks when/)
      expect(proof).not.toMatch(/consumes exactly one seat/)
      expect(proof).toContain('MQA-068')
    }
  })

  it('every doc that describes the gate says it is compiled off, not merely defaulted off', () => {
    if (!enforcementCompiledOff) return
    for (const rel of ['README.md', 'docs/asktoto-architecture.md', 'docs/license-platform-plan.md']) {
      const doc = read(rel)
      expect(doc, `${rel} must name the real switch`).toMatch(/LICENSE_ENFORCEMENT/)
      // The exact claim that was false: that turning the SETTING on turns the subsystem on.
      expect(doc, `${rel} still promises the setting activates the gate`).not.toMatch(
        /when a company\s+turns it on, the app phones home/
      )
    }
  })

  it("main's own header does not claim the subsystem is wired into live enforcement", () => {
    if (!enforcementCompiledOff) return
    const header = read('src/main/license.ts').slice(0, 1400)
    expect(header).toMatch(/COMPILED OFF/)
    expect(header).toContain('MQA-068')
  })
})
