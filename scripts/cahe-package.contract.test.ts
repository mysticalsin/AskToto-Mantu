import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(__dirname, '..')

describe('Cahê Windows package contract', () => {
  it('builds a separate Windows-only NSIS installer without publishing to the shared update feed', () => {
    const config = readFileSync(join(root, 'electron-builder.cahe.win.yml'), 'utf8')
    const buildScript = readFileSync(join(root, 'scripts', 'build-cahe-windows.mjs'), 'utf8')
    const packageCheck = readFileSync(join(root, 'scripts', 'check-cahe-package.mjs'), 'utf8')
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }

    expect(config).toContain('appId: com.mantu.metis.windows-cahe')
    expect(config).toContain('productName: Metis Windows Cahe')
    expect(config).toContain('executableName: Metis-Windows-Cahe')
    expect(config).toContain('artifactName: Metis-Windows-Cahe-Setup-${version}.${ext}')
    expect(config).toContain('- nsis')
    expect(config).not.toContain('- portable')
    expect(buildScript).toMatch(/'--publish',\s*'never'/)
    expect(buildScript).toContain("'--executable=Metis-Windows-Cahe.exe'")
    expect(buildScript).toContain("'scripts/check-cahe-package.mjs'")
    expect(packageCheck).toContain("'out/main/index.jsc'")
    expect(packageCheck).toContain('sourceMainBytecode')
    expect(pkg.scripts['installers:win:cahe']).toBe('node scripts/build-cahe-windows.mjs')
  })
})
