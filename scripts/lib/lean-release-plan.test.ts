import { describe, expect, it } from 'vitest'
import { RELEASE_PACKAGE_PROFILE, formatStep, leanReleasePlan, parseLeanReleaseArgs } from './lean-release-plan.mjs'

type Step = { name: string; command?: string; args?: string[]; env?: Record<string, string>; collect?: unknown }

const text = (steps: Step[]) => steps.map((step) => formatStep(step))
const indexOf = (lines: string[], needle: string) => {
  const found = lines.findIndex((line) => line.includes(needle))
  expect(found, `missing step containing ${needle}`).toBeGreaterThanOrEqual(0)
  return found
}
type Plan = { outputDir: string; appDir: string; steps: Step[] }
const plan = (options: Record<string, unknown>): Plan =>
  (leanReleasePlan as (input: Record<string, unknown>) => Plan)({ hostArch: 'arm64', ...options })

describe('lean is the release profile (G11)', () => {
  it('declares lean as the release package profile', () => {
    expect(RELEASE_PACKAGE_PROFILE).toBe('lean')
  })

  it('pins the lean profile and the exact architecture on every build and packaging step', () => {
    for (const options of [
      { target: 'mac', arch: 'arm64' },
      { target: 'mac', arch: 'x64' },
      { target: 'mac', arch: 'arm64', qaIdentity: true },
      { target: 'win', arch: 'x64' }
    ]) {
      const steps = plan(options).steps
      for (const step of steps.filter((item) =>
        /electron-builder|\bbuild$/.test(`${item.command} ${item.args?.join(' ')}`)
      )) {
        expect(step.env?.METIS_PACKAGE_PROFILE, step.name).toBe(RELEASE_PACKAGE_PROFILE)
      }
      const builder = steps.find((item) => item.args?.includes('electron-builder'))
      expect(builder?.env?.METIS_PACKAGE_ARCH).toBe(options.arch)
    }
  })

  it('never fetches or stages the bundled inference payloads a full package needs', () => {
    for (const options of [
      { target: 'mac', arch: 'arm64' },
      { target: 'mac', arch: 'x64' },
      { target: 'win', arch: 'x64' }
    ]) {
      const joined = text(plan(options).steps).join('\n')
      for (const forbidden of [
        'fetch-models',
        'fetch-local-model',
        'fetch-llama-server',
        'fetch-speaker-model',
        'check-sherpa-platform',
        'provision-mac-natives',
        'check-packaged-runtime'
      ]) {
        expect(joined).not.toContain(forbidden)
      }
    }
  })

  it('embeds the enrolment blob before packaging and checks the package after, like every other chain (O11)', () => {
    for (const options of [
      { target: 'mac', arch: 'arm64' },
      { target: 'mac', arch: 'x64' },
      { target: 'win', arch: 'x64' }
    ]) {
      const lines = text(plan(options).steps)
      const embed = indexOf(lines, 'embed-operator-enroll-token.mjs')
      const pack = indexOf(lines, 'electron-builder')
      const check = indexOf(lines, 'check-embedded-operator-enroll.mjs')
      expect(embed).toBeLessThan(pack)
      expect(check).toBeGreaterThan(pack)
      expect(indexOf(lines, 'embed-cloudflare-key.mjs')).toBeLessThan(pack)
      expect(indexOf(lines, 'check-embedded-cloudflare-key.mjs')).toBeGreaterThan(pack)
      expect(lines[embed]).not.toContain('--qa')
    }
  })

  it('only the QA identity build uses the QA token variables and the QA builder config', () => {
    const qa = text(plan({ target: 'mac', arch: 'arm64', qaIdentity: true }).steps)
    expect(qa[indexOf(qa, 'embed-operator-enroll-token.mjs')]).toContain('--qa')
    expect(qa[indexOf(qa, 'electron-builder')]).toContain('--config build/qa-identity.electron-builder.yml')
    expect(qa[indexOf(qa, 'electron-builder')]).toContain('METIS_QA_IDENTITY=1')
    expect(qa[indexOf(qa, 'electron-builder')]).not.toContain('artifactName')
    const plain = text(plan({ target: 'mac', arch: 'arm64' }).steps).join('\n')
    expect(plain).not.toContain('qa-identity')
    expect(plain).not.toContain('METIS_QA_IDENTITY')
  })

  it('names each macOS installer by architecture so both can ship side by side', () => {
    for (const arch of ['arm64', 'x64']) {
      const line = text(plan({ target: 'mac', arch }).steps)
      const builder = line[indexOf(line, 'electron-builder')]
      expect(builder).toContain('--mac dmg zip')
      expect(builder).toContain(`--${arch}`)
      expect(builder).toContain('-c.mac.artifactName=Metis-${version}-${arch}.${ext}')
    }
  })

  it('compiles without V8 bytecode only when the target architecture is not the build host', () => {
    const buildOf = (options: Record<string, unknown>) =>
      plan(options).steps.find((step) => step.args?.join(' ') === 'run build')
    expect(buildOf({ target: 'mac', arch: 'x64', hostArch: 'arm64' })?.env?.ASKTOTO_MAC_UNIVERSAL).toBe('1')
    expect(buildOf({ target: 'mac', arch: 'arm64', hostArch: 'arm64' })?.env?.ASKTOTO_MAC_UNIVERSAL).toBeUndefined()
    expect(buildOf({ target: 'win', arch: 'x64', hostArch: 'x64' })?.env?.ASKTOTO_MAC_UNIVERSAL).toBeUndefined()
  })

  it('builds each architecture into its own directory, then moves only installers up to the release directory', () => {
    const arm = plan({ target: 'mac', arch: 'arm64' })
    const intel = plan({ target: 'mac', arch: 'x64' })
    expect(arm.outputDir).toBe('release/lean-mac-arm64')
    expect(intel.outputDir).toBe('release/lean-mac-x64')
    expect(arm.appDir).toBe('release/lean-mac-arm64/mac-arm64')
    expect(intel.appDir).toBe('release/lean-mac-x64/mac')
    for (const built of [arm, intel]) {
      const last = built.steps.at(-1)
      expect(last?.collect).toEqual({ from: built.outputDir, to: 'release', pattern: '\\.(dmg|zip|exe)$' })
    }
    const win = plan({ target: 'win', arch: 'x64' })
    expect(win.outputDir).toBe('release/lean-win-x64')
    expect(win.appDir).toBe('release/lean-win-x64')
    const winBuilder = text(win.steps)[indexOf(text(win.steps), 'electron-builder')]
    expect(winBuilder).toContain('--config electron-builder.win.yml --win nsis portable --x64')
  })

  it('applies the same profile, inventory and enrolment gates to the unsigned release candidates', () => {
    const lines = text(plan({ target: 'mac', arch: 'arm64' }).steps)
    expect(indexOf(lines, 'measure-lean-candidate.mjs mac arm64 release/lean-mac-arm64')).toBeGreaterThan(
      indexOf(lines, 'electron-builder')
    )
    expect(lines.join('\n')).toContain('ASKTOTO_ADHOC_SIGN=1')
  })

  it('rejects combinations that cannot produce a verified lean package', () => {
    expect(() => parseLeanReleaseArgs(['linux', 'x64'])).toThrow(/mac or win/)
    expect(() => parseLeanReleaseArgs(['mac', 'universal'])).toThrow(/arm64 or x64/)
    expect(() => parseLeanReleaseArgs(['win', 'arm64'])).toThrow(/x64 only/)
    expect(() => parseLeanReleaseArgs(['mac', 'x64', '--qa-identity'])).toThrow(/arm64/)
    expect(() => parseLeanReleaseArgs(['win', 'x64', '--qa-identity'])).toThrow(/macOS/)
    expect(() => parseLeanReleaseArgs(['mac', 'arm64', '--bogus'])).toThrow(/Unknown option/)
    expect(parseLeanReleaseArgs(['mac', 'arm64', '--qa-identity', '--dry-run'])).toEqual({
      target: 'mac',
      arch: 'arm64',
      qaIdentity: true,
      dryRun: true
    })
  })
})
