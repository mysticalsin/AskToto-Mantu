import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

/**
 * mac-chain-gates.contract.test.ts — the mac packaging chains, pinned where they are load-bearing.
 *
 * Two things are asserted here, both about `package.json`'s mac scripts rather than about any code
 * that runs at app runtime, because that is where these defects live.
 *
 * MQA-207 — the real-launch gate (scripts/check-packaged-launch.mjs) is Win32-only by construction and
 * the mac chains deliberately do NOT call it: wiring it in would hard-fail every mac build, since the
 * script refuses on a host it cannot inspect. That refusal must stay a refusal (exit 2, never 0 — a
 * gate that silently passes is worse than no gate) and must keep printing the manual procedure that
 * covers the gap, including the Rosetta run of the universal DMG's second slice. The Windows chains
 * that DO have automated coverage must keep it.
 *
 * MQA-208 — every mac chain that invokes electron-builder must first stage a checksum-verified Electron
 * distribution through scripts/provision-electron-dist.mjs and point electron-builder at it. release:mas
 * was the one chain that did neither, so it was the one chain still exposed to @electron/get's checksum
 * defect, and the archive it needs (`electron-v<version>-mas-arm64.zip`) is a different file from the
 * darwin one that electron-builder.yml pins.
 *
 * Text-level assertions on package.json scripts, matching how release-gates.test.ts already pins these
 * same chains; the one behavioural assertion (unknown --platform is rejected) is exercised for real.
 */

const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}
const launchGate = readFileSync(join(root, 'scripts', 'check-packaged-launch.mjs'), 'utf8')

/** Every npm script that actually invokes electron-builder against a mac target. */
const MAC_BUILD_CHAINS = ['dist', 'dist:local', 'release:build:mac', 'release:mas']

/** A chain plus whatever npm runs ahead of it — `dist` does its provisioning in `predist`. */
function chainWithHook(name: string): string {
  const pre = pkg.scripts[`pre${name}`]
  return pre ? `${pre} && ${pkg.scripts[name]}` : pkg.scripts[name]
}

describe('MQA-208 — release:mas stages Electron like every other mac chain', () => {
  it('MQA-208: every mac chain provisions a verified Electron dist and points electron-builder at it', () => {
    for (const name of MAC_BUILD_CHAINS) {
      const script = pkg.scripts[name]
      expect(script, `missing script: ${name}`).toBeTruthy()
      expect(
        chainWithHook(name),
        `${name} invokes electron-builder without staging Electron`
      ).toContain('scripts/provision-electron-dist.mjs')
      expect(script, `${name} stages Electron but does not point electron-builder at it`).toContain(
        '-c.electronDist=resources/electron-dist'
      )
    }
  })

  it('MQA-208: release:mas stages the mas archive, not the darwin one', () => {
    // app-builder-lib resolves the archive as `electron-v<version>-<platformName>-<arch>.zip` and
    // platformName is "mas" for the Mac App Store target (macPackager.getPlatformConfig), so staging
    // darwin-arm64 here would leave the directory without the file electron-builder looks for — and
    // ElectronFramework then falls through to its "already-unpacked distribution" branch, which copies
    // the directory verbatim and produces a broken .app instead of failing.
    expect(pkg.scripts['release:mas']).toContain(
      'node scripts/provision-electron-dist.mjs --platform=mas arm64'
    )
    expect(pkg.scripts['release:mas']).toMatch(/electron-builder --mac mas --arm64[^&]*-c\.electronDist=resources\/electron-dist/)
  })

  it('MQA-208: the archive release:mas asks for is a real published Electron artifact', () => {
    const version = (
      JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')) as {
        version: string
      }
    ).version
    const checksums = JSON.parse(
      readFileSync(join(root, 'node_modules', 'electron', 'checksums.json'), 'utf8')
    ) as Record<string, string>
    expect(Object.keys(checksums)).toContain(`electron-v${version}-mas-arm64.zip`)
  })

  it('MQA-208: provision-electron-dist rejects an unknown platform before it downloads anything', () => {
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts', 'provision-electron-dist.mjs'), '--platform=bogus', 'arm64'],
      { encoding: 'utf8' }
    )
    expect(result.status).toBe(1)
    expect(`${result.stderr}${result.stdout}`).toMatch(/--platform/)
    expect(`${result.stderr}${result.stdout}`).toMatch(/darwin/)
    expect(`${result.stderr}${result.stdout}`).toMatch(/mas/)
  })
})

describe('MQA-207 — the launch gate never silently covers a host it cannot inspect', () => {
  it('MQA-207: the Windows chains keep their real-launch gate', () => {
    for (const name of ['dist:win', 'release:build:win']) {
      expect(pkg.scripts[name]).toContain(
        'node scripts/check-packaged-launch.mjs release/win-unpacked/Metis.exe'
      )
    }
  })

  it('MQA-207: no mac chain calls the Win32-only launch gate', () => {
    // Not an oversight to be "fixed" by wiring it in: the script exits 2 on any non-win32 host, so a
    // mac chain that called it could never go green. macOS needs its own gate first.
    for (const name of MAC_BUILD_CHAINS) {
      expect(pkg.scripts[name]).not.toContain('check-packaged-launch.mjs')
    }
  })

  it('MQA-207: the gate refuses on a foreign host instead of exiting 0', () => {
    const refusal = launchGate.slice(launchGate.indexOf("if (process.platform !== 'win32')"))
    expect(refusal).toContain('process.exit(2)')
    expect(refusal.slice(0, refusal.indexOf('process.exit(2)'))).not.toContain('process.exit(0)')
  })

  it('MQA-207: the darwin refusal names the manual check that covers the universal DMG', () => {
    // The two slices still differ in everything this Win32 script could never inspect — per-arch native
    // modules, the ffmpeg/llama-server sidecars, signing — so the refusal has to hand the maintainer the
    // two commands that actually exercise both, and name cachedDataRejected as the signature to
    // recognise if the bytecode ever comes back (MQA-240, pinned in scripts/release-gates.test.ts).
    expect(launchGate).toContain('arch -x86_64')
    expect(launchGate).toContain('release/mac-universal/Metis.app')
    expect(launchGate).toMatch(/cachedDataRejected/)
  })
})
