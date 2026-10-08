import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(join(__dirname, '../..', path), 'utf8').replace(/\r\n/g, '\n')
const workflow = read('.github/workflows/qa-candidate.yml')
const brokerWorkflow = read('.github/workflows/isolation-canary.yml')
const probe = read('scripts/hermetic/check-security-brokers.c')
const verifier = read('scripts/hermetic/verify-security-brokers.sh')
const profile = read('scripts/hermetic/owner-runner.sb')
const main = read('scripts/qa/st-1.mjs').split('async function main()')[1]
const services = [
  'com.apple.SecurityServer',
  'com.apple.securityd',
  'com.apple.securityd.xpc',
  'com.apple.securityd.systemkeychain',
  'com.apple.securityd.aps',
  'com.apple.securityd.ckks',
  'com.apple.securityd.general',
  'com.apple.securityd.sos',
  'com.apple.security.octagon',
  'com.apple.security.escrow-update',
  'com.apple.security.kcsharing'
]

function job(source: string, name: string) {
  const block = source.split(`\n  ${name}:\n`)[1]
  expect(block, `missing ${name}`).toBeDefined()
  return block.split(/\n {2}[a-z0-9-]+:\n/)[0]
}

describe('Security broker isolation wiring [M2-0538]', () => {
  it.each([
    'st1-mac-fifo',
    'st1-mac-control'
  ])('binds pre/post and each actual %s launch to the pinned probe', (name) => {
    const steps = job(workflow, name)
      .split(/^(?= {6}- )/m)
      .slice(1)
    const one = (pattern: RegExp) => {
      const matches = steps.filter((step) => pattern.test(step))
      expect(matches).toHaveLength(1)
      return matches[0]
    }
    const before = one(/^ {8}id: qa_keychain_before$/m)
    const after = one(/^ {8}id: qa_keychain_after$/m)
    const launch = one(/node scripts\/qa\/st-1\.mjs/)
    expect(before).toContain('scripts/hermetic/prepare-security-brokers.sh')
    expect(before).toContain('check_sha256=$(/usr/bin/shasum -a 256 "$check_path")')
    expect(before).toContain('check_sha256=%s')
    for (const step of [before, after]) {
      expect(step).toContain('shell: /bin/bash --noprofile --norc -euo pipefail {0}')
      expect(step).toContain('BASH_ENV: /dev/null')
      expect(step).toContain('ENV: /dev/null')
      expect(step).toContain('OWNER_SANDBOX_PROFILE: owner-runner.sb')
      expect(step).toContain(
        '/bin/bash scripts/hermetic/run-under-owner-sandbox.sh /bin/bash --noprofile --norc scripts/hermetic/verify-security-brokers.sh'
      )
      expect(step).not.toContain('QA_SERVICE_ABSENT')
    }
    expect(after.indexOf('[ "${actual%% *}" = "$QA_CHECK_SHA256" ]')).toBeGreaterThan(0)
    expect(after.indexOf('[ "${actual%% *}" = "$QA_CHECK_SHA256" ]')).toBeLessThan(
      after.indexOf('/bin/bash scripts/hermetic/run-under-owner-sandbox.sh')
    )
    for (const step of [after, launch]) {
      expect(step).toContain('QA_CHECK_PATH: ${{ steps.qa_keychain_before.outputs.check_path }}')
      expect(step).toContain('QA_CHECK_SHA256: ${{ steps.qa_keychain_before.outputs.check_sha256 }}')
      expect(step).toContain('OWNER_QA_CONTROL_DIR: ${{ steps.qa_keychain_before.outputs.control_dir }}')
    }
    expect(launch).toContain("ASKTOTO_LOCAL_KEYSTORE: '1'")
  })

  it('uses only fixed bootstrap lookups and fails on unexpected status, port or cleanup', () => {
    expect([...probe.matchAll(/"(com\.apple\.[^"]+)"/g)].map((match) => match[1])).toEqual(services)
    for (const service of services) {
      expect(profile).toContain(`(deny mach-lookup (global-name "${service}"))`)
    }
    expect(probe).toContain('bootstrap_look_up(bootstrap_port, services[i], &port)')
    expect(probe).toContain('status != BOOTSTRAP_NOT_PRIVILEGED || unexpected_port')
    expect(probe).toContain('mach_port_deallocate(mach_task_self(), port)')
    expect(probe).toContain('cleanup != KERN_SUCCESS')
    expect(probe).toContain('argc != 1')
    expect(probe).toContain('alarm(10)')
    expect(probe).not.toMatch(/#include <(?:Security|CoreFoundation)|SecItem|SecKeychain|CSSM|getenv\(/)
    expect(verifier).toContain('/usr/bin/env -i "$QA_CHECK_PATH" > "$observed"')
    expect(verifier).toContain('/usr/bin/cmp -s "$expected" "$observed"')
    expect(verifier.indexOf('[ "${actual%% *}" = "$QA_CHECK_SHA256" ]')).toBeLessThan(
      verifier.indexOf('/usr/bin/env -i "$QA_CHECK_PATH"')
    )
  })

  it('observes broker denial after validated identity and before measuring or spawning the candidate', () => {
    const validate = main.indexOf('validateRestrictedExecutable(')
    const observe = main.indexOf('observeSecurityBrokers(launchEnv)')
    const timed = main.indexOf('const spawnedAt = performance.now()')
    expect(validate).toBeGreaterThan(0)
    expect(observe).toBeGreaterThan(validate)
    expect(timed).toBeGreaterThan(observe)
    expect(main).toContain(
      'if (planned.restricted) launchObservation.brokerLookupDenial = observeSecurityBrokers(launchEnv)'
    )
  })

  it('runs independent hosted filesystem and broker proofs without report-only or change-skip policies', () => {
    for (const name of ['owner-runner-synthetic', 'owner-security-brokers']) {
      const block = job(brokerWorkflow, name)
      expect(block).toContain('runs-on: macos-latest')
      expect(block).toContain('timeout-minutes: 10')
      expect(block).not.toMatch(/^ {4}(?:if|needs|continue-on-error):/m)
    }
    expect(job(brokerWorkflow, 'owner-security-brokers')).toContain(
      'run: bash scripts/hermetic/prove-security-brokers-synthetic.sh'
    )
  })
})
