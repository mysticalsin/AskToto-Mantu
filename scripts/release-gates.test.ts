import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  description: string
  scripts: Record<string, string>
  devDependencies: Record<string, string>
  engines: { node: string }
}

describe('installer branding', () => {
  it('uses a customer-facing Métis file description without internal migration notes', () => {
    expect(pkg.description).toBe('Métis - AI desktop overlay assistant')
  })

  it('uses an accented Windows display name while keeping executable paths ASCII', () => {
    const overlay = readFileSync(join(root, 'electron-builder.win.yml'), 'utf8')
    expect(overlay).toContain('extends: ./electron-builder.yml')
    expect(overlay).toContain('productName: Métis')
    expect(overlay).toContain('executableName: Metis')
    expect(overlay).toContain("!node_modules/sherpa-onnx-darwin-*{,/**/*}")
    expect(overlay).toContain("!node_modules/sherpa-onnx-linux-*{,/**/*}")
    expect(overlay).toContain("!node_modules/@img/sharp-linux-*{,/**/*}")

    // release:build:win is intentionally excluded here: it now goes through the mode-aware config-overlay
    // wrapper (scripts/electron-builder-win.mjs), asserted separately below, not the literal filename.
    for (const script of ['dist:win', 'dist:win:appx', 'release:win:store']) {
      expect(pkg.scripts[script]).toContain('--config electron-builder.win.yml')
    }
    const installerBuilder = readFileSync(join(root, 'scripts', 'build-installers.mjs'), 'utf8')
    expect(installerBuilder).toMatch(/'--config',\s*'electron-builder\.win\.yml'/)
  })
})

describe('deterministic packaging toolchain', () => {
  it('pins the audited Electron build stack exactly', () => {
    expect(pkg.devDependencies['@electron/asar']).toBe('3.4.1')
    expect(pkg.devDependencies.electron).toBe('43.6.0')
    expect(pkg.devDependencies['electron-builder']).toBe('26.15.3')
    expect(pkg.devDependencies['electron-vite']).toBe('5.0.0')
    expect(pkg.devDependencies.vite).toBe('7.3.6')
  })

  it('uses the maintained Electron extractor rather than the vulnerable legacy package', () => {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { dependencies?: Record<string, string> }>
    }
    const electron = lock.packages['node_modules/electron']
    expect(electron.dependencies?.['@electron-internal/extract-zip']).toBeDefined()
    expect(electron.dependencies?.['extract-zip']).toBeUndefined()
    expect(lock.packages['node_modules/extract-zip']).toBeUndefined()
  })

  it('uses the same supported Node LTS patch across local development and CI', () => {
    const expected = '22.22.3'
    expect(pkg.engines.node).toBe(expected)
    expect(readFileSync(join(root, '.nvmrc'), 'utf8').trim()).toBe(expected)
    expect(readFileSync(join(root, '.node-version'), 'utf8').trim()).toBe(expected)
    for (const workflow of ['build.yml', 'release.yml']) {
      const source = readFileSync(join(root, '.github', 'workflows', workflow), 'utf8')
      const pins = [...source.matchAll(/node-version:\s*([\d.]+)/g)].map((match) => match[1])
      expect(pins.length).toBeGreaterThan(0)
      expect(new Set(pins)).toEqual(new Set([expected]))
    }
  })

  it('pins the official Electron checksums needed by offline Mac and Windows builds', () => {
    const builderConfig = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    const electron = JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8')) as {
      version: string
    }
    const officialChecksums = JSON.parse(
      readFileSync(join(root, 'node_modules/electron/checksums.json'), 'utf8')
    ) as Record<string, string>

    for (const target of ['darwin-arm64', 'darwin-x64', 'win32-x64']) {
      const file = `electron-v${electron.version}-${target}.zip`
      expect(builderConfig).toContain(`${file}: ${officialChecksums[file]}`)
    }
  })

  it('does not package Dust client server dependencies that Métis never imports', () => {
    const builderConfig = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    expect(pkg.scripts.postinstall).toBe(
      'node scripts/prune-dust-bundle.mjs && node scripts/ensure-electron-runtime.mjs'
    )
    for (const dependency of ['@modelcontextprotocol/sdk', 'express-rate-limit', 'ip-address']) {
      expect(builderConfig).toContain(
        `!node_modules/@dust-tt/client/node_modules/${dependency}{,/**/*}`
      )
    }
  })

  it('checks the exact host runtime before compiling bytecode or launching the app', () => {
    const gate = 'node scripts/ensure-electron-runtime.mjs --check-only && '
    for (const script of ['prebuild', 'dev', 'preview', 'start']) {
      expect(pkg.scripts[script].startsWith(gate), script).toBe(true)
    }
  })

  it('uses electron-vite 5 configuration instead of its deprecated plugin shims', () => {
    const viteConfig = readFileSync(join(root, 'electron.vite.config.ts'), 'utf8')
    expect(viteConfig).not.toContain('externalizeDepsPlugin')
    expect(viteConfig).not.toContain('bytecodePlugin')
    expect(viteConfig).toContain("externalizeDeps: { exclude: ['zod'] }")
  })

  // MQA-240 (the DOA itself; MQA-207 is the missing mac launch gate that let it through).
  // This used to assert a bare `bytecode: true`. That assertion encoded a bug: a V8 code
  // cache is per-architecture, so the single out/main/index.jsc baked into a --universal package is
  // loadable by only ONE of its two slices. The Intel slice died on launch with
  // "Invalid or incompatible cached data (cachedDataRejected)", reported from a real 1.6.0 DMG.
  it('MQA-207: main-process bytecode is on by default and off only for the mac universal package', () => {
    const viteConfig = readFileSync(join(root, 'electron.vite.config.ts'), 'utf8')
    expect(viteConfig).toContain("const MAC_UNIVERSAL = process.env.ASKTOTO_MAC_UNIVERSAL === '1'")
    expect(viteConfig).toContain('bytecode: !MAC_UNIVERSAL')
    // Fail-open in the right direction: with the flag unset, bytecode is ON.
    expect(viteConfig).not.toContain('bytecode: false')
  })

  it('MQA-207: every --universal mac chain disables bytecode, and no single-arch chain does', () => {
    const scripts = pkg.scripts as Record<string, string>
    const universal = Object.entries(scripts).filter(([, v]) => v.includes('--universal'))
    expect(universal.length).toBeGreaterThanOrEqual(3)
    for (const [name, body] of universal) {
      expect(body, `${name} builds --universal so it must disable bytecode`).toContain(
        'ASKTOTO_MAC_UNIVERSAL=1 npm run build'
      )
    }
    for (const [name, body] of Object.entries(scripts)) {
      if (body.includes('ASKTOTO_MAC_UNIVERSAL')) {
        expect(body, `${name} sets the universal flag but does not build --universal`).toContain('--universal')
      }
    }
  })

  it('MQA-207: single-architecture Windows chains keep their bytecode', () => {
    const scripts = pkg.scripts as Record<string, string>
    for (const name of ['dist:win', 'dist:win:appx', 'installers:win:cahe']) {
      if (scripts[name]) expect(scripts[name]).not.toContain('ASKTOTO_MAC_UNIVERSAL')
    }
  })
})

describe('direct release signing gates', () => {
  it('tests the tagged source on Windows as well as Linux before packaging', () => {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8')
    const sourceGate = workflow.slice(workflow.indexOf('  release-quality:'), workflow.indexOf('  release-macos:'))
    expect(sourceGate).toContain('os: [ubuntu-latest, windows-latest]')
    expect(sourceGate).toContain('fail-fast: false')
    expect(sourceGate).toContain('npm test')
    expect(sourceGate).toContain("runner.os == 'Linux' && '--with-deps'")
  })

  it('keeps shared Cloudflare provider credentials out of the standard public installers', () => {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8')
    expect(workflow).not.toContain('METIS_CLOUDFLARE_API_TOKEN:')
    expect(workflow).not.toContain('METIS_CLOUDFLARE_ACCOUNT_ID:')
    expect(workflow).not.toContain('METIS_EMBED_CLOUDFLARE_KEY:')
  })

  // Successor to the old single "requires an explicit expected Windows signer identity" test: the gate
  // is now mode-aware (scripts/lib/windows-signing-mode.mjs), so "missing subject" is one row of a
  // fail-closed matrix rather than the only failure shape. Every row below still asserts the same thing
  // that test asserted (status 1, WIN_CSC_EXPECTED_SUBJECT named), plus the modes that did not exist yet.
  describe('mode-aware Windows signing gate (pfx / azure / both / neither)', () => {
    const PFX_COMPLETE = {
      WIN_SIGNING_MODE: 'pfx',
      WIN_CSC_LINK: 'synthetic-pkcs12-fixture',
      WIN_CSC_KEY_PASSWORD: 'synthetic-password-never-log',
      WIN_CSC_EXPECTED_SUBJECT: 'synthetic-publisher-never-log'
    }
    const AZURE_COMPLETE = {
      WIN_SIGNING_MODE: 'azure',
      WIN_AZURE_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net',
      WIN_AZURE_SIGNING_ACCOUNT: 'synthetic-account',
      WIN_AZURE_CERT_PROFILE: 'synthetic-profile',
      WIN_AZURE_PUBLISHER_NAME: 'synthetic-publisher-never-log',
      WIN_CSC_EXPECTED_SUBJECT: 'synthetic-publisher-never-log'
    }

    function runGate(env: Record<string, string>) {
      return spawnSync(process.execPath, [join(__dirname, 'check-release-secrets.mjs'), 'win'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH || '', GH_TOKEN: 'test-token', ...env }
      })
    }

    it('accepts a complete pfx configuration', () => {
      const result = runGate(PFX_COMPLETE)
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('OK - win (pfx)')
    })

    it('accepts a complete azure configuration', () => {
      const result = runGate(AZURE_COMPLETE)
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('OK - win (azure)')
    })

    it('refuses when inputs for both modes are present (ambiguous), naming variables but never values', () => {
      for (const env of [
        { ...PFX_COMPLETE, ...AZURE_COMPLETE, WIN_SIGNING_MODE: 'pfx' },
        { ...PFX_COMPLETE, ...AZURE_COMPLETE, WIN_SIGNING_MODE: 'azure' }
      ]) {
        const result = runGate(env)
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('refusing to publish an unsigned Windows release')
        for (const secret of ['synthetic-pkcs12-fixture', 'synthetic-password-never-log', 'synthetic-publisher-never-log']) {
          expect(result.stderr).not.toContain(secret)
        }
      }
    })

    it('refuses when no signing mode is configured at all', () => {
      const result = runGate({})
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('refusing to publish an unsigned Windows release')
    })

    it('refuses an incomplete pfx configuration, naming the missing expected-subject variable', () => {
      const result = runGate({
        WIN_SIGNING_MODE: 'pfx',
        WIN_CSC_LINK: 'synthetic-pkcs12-fixture',
        WIN_CSC_KEY_PASSWORD: 'synthetic-password-never-log'
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('WIN_CSC_EXPECTED_SUBJECT')
      expect(result.stderr).toContain('refusing to publish an unsigned Windows release')
    })

    it('refuses an incomplete azure configuration', () => {
      const result = runGate({ WIN_SIGNING_MODE: 'azure', WIN_AZURE_SIGNING_ENDPOINT: AZURE_COMPLETE.WIN_AZURE_SIGNING_ENDPOINT })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('refusing to publish an unsigned Windows release')
    })
  })

  it('release:build:win runs through the mode-aware config-overlay wrapper', () => {
    expect(pkg.scripts['release:build:win']).toContain('node scripts/electron-builder-win.mjs')
    const wrapper = readFileSync(join(root, 'scripts', 'electron-builder-win.mjs'), 'utf8')
    expect(wrapper).toContain("'--config'")
    // The overlay's `extends` value is built in scripts/lib/windows-signing-mode.mjs; the wrapper's own
    // contract is passing it the real base config path rather than a guessed or hardcoded one.
    expect(wrapper).toContain('electron-builder.win.yml')
  })

  it('verifies produced signatures in both direct release commands', () => {
    expect(pkg.scripts['release:build:mac']).toContain('node scripts/verify-signing.mjs --require-notarized')
    expect(pkg.scripts['release:build:win']).toContain('node scripts/verify-signing.mjs')
  })

  it('refuses macOS release when Developer ID or notarization inputs are missing, including in CI', () => {
    for (const env of [
      { GH_TOKEN: 'test-token' },
      { GH_TOKEN: 'test-token', GITHUB_ACTIONS: 'true' },
      { GH_TOKEN: 'test-token', ASKTOTO_ALLOW_ADHOC_MAC: '1' },
      { GH_TOKEN: 'test-token', GITHUB_ACTIONS: 'true', ASKTOTO_ALLOW_ADHOC_MAC: '1' }
    ]) {
      const result = spawnSync(process.execPath, [join(__dirname, 'check-release-secrets.mjs'), 'mac'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH || '', ...env }
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('CSC_LINK')
      expect(result.stderr).toContain('APPLE_TEAM_ID')
    }
  })

  it('accepts a complete macOS Developer ID and notarization configuration', () => {
    const result = spawnSync(process.execPath, [join(__dirname, 'check-release-secrets.mjs'), 'mac'], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH || '',
        GH_TOKEN: 'test-token',
        CSC_LINK: 'test-certificate',
        CSC_KEY_PASSWORD: 'test-password',
        APPLE_ID: 'release@example.test',
        APPLE_APP_SPECIFIC_PASSWORD: 'test-app-password',
        APPLE_TEAM_ID: 'TESTTEAM01'
      }
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('OK - mac')
  })

  it('release.yml publishes only notarized Electron macOS artifacts and excludes the unsigned native ZIP', () => {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8')
    const macGate = workflow.slice(workflow.indexOf('  release-macos:'), workflow.indexOf('  release-windows:'))
    const publishGate = workflow.slice(workflow.indexOf('  release-verify:'))
    expect(macGate).toContain('node scripts/check-release-secrets.mjs mac')
    expect(macGate).toContain('node scripts/verify-signing.mjs --require-notarized')
    expect(macGate).not.toContain('ASKTOTO_ALLOW_ADHOC_MAC')
    expect(macGate).not.toContain('ASKTOTO_ADHOC_SIGN')
    expect(macGate).not.toContain('CSC_IDENTITY_AUTO_DISCOVERY')
    expect(macGate).not.toMatch(/-c\.mac\.identity=null/)
    expect(macGate).not.toMatch(/ADHOC|not Gatekeeper-notarized/)
    const verifier = readFileSync(join(root, 'scripts', 'verify-signing.mjs'), 'utf8')
    expect(verifier).toMatch(/const REQUIRE_NOTARIZED = process\.argv\.includes\(['"]--require-notarized['"]\)/)
    expect(verifier).not.toContain('ASKTOTO_ALLOW_ADHOC_MAC')
    expect(workflow).not.toContain('release-macos-native:')
    expect(publishGate).not.toContain('Metis-Native-${version}.zip')
    const winGate = workflow.slice(workflow.indexOf('release-windows:'))
    expect(winGate).toContain('refusing to publish an unsigned Windows release')
    expect(winGate).toContain('WIN_CSC_EXPECTED_SUBJECT')
  })
})
