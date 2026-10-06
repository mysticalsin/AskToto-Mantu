import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SENTINEL,
  declaredFuses,
  flipFusesConfig,
  fuseMismatches,
  harnessCopy,
  parseBuilderConfig,
  readFuseWires,
  runCheck,
  runSet,
  setFuse
} from './electron-fuses.mjs'

// One character per fuse in wire order: runAsNode, cookieEncryption, nodeOptions, nodeCliInspect,
// asarIntegrity, onlyLoadAppFromAsar, browserV8Snapshot, fileProtocolPrivileges.
const ELECTRON_DEFAULTS = '10110001'
const SHIPPED = '10001101'
const QA_IDENTITY = '10011101'

const SHIPPED_DECLARATION = {
  runAsNode: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true
}

function electronBinary(...wires: string[]): Buffer {
  const slices = wires.map((wire) => {
    const wireBytes = Buffer.concat([SENTINEL, Buffer.from([1, wire.length]), Buffer.from(wire, 'ascii')])
    return Buffer.concat([Buffer.from('mach-o slice bytes '), wireBytes])
  })
  return Buffer.concat([...slices, Buffer.from(' trailing bytes')])
}

const FRAMEWORK = join('Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework')
const QA_DECLARATION = { ...SHIPPED_DECLARATION, enableNodeCliInspectArguments: true }

const temporaryDirectories: string[] = []
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'metis-electron-fuses-'))
  temporaryDirectories.push(directory)
  return directory
}

function macApp(binary: Buffer): string {
  const app = join(temporaryDirectory(), 'Metis.app')
  mkdirSync(dirname(join(app, FRAMEWORK)), { recursive: true })
  writeFileSync(join(app, FRAMEWORK), binary)
  return app
}

function windowsExe(binary: Buffer): string {
  const exe = join(temporaryDirectory(), 'Metis.exe')
  writeFileSync(exe, binary)
  return exe
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('reading the fuse wire', () => {
  it('names every fuse state of a single wire', () => {
    expect(readFuseWires(electronBinary(ELECTRON_DEFAULTS))).toEqual([
      {
        version: 1,
        length: 8,
        fuses: {
          runAsNode: 'on',
          enableCookieEncryption: 'off',
          enableNodeOptionsEnvironmentVariable: 'on',
          enableNodeCliInspectArguments: 'on',
          enableEmbeddedAsarIntegrityValidation: 'off',
          onlyLoadAppFromAsar: 'off',
          loadBrowserProcessSpecificV8Snapshot: 'off',
          grantFileProtocolExtraPrivileges: 'on'
        }
      }
    ])
  })

  it('reads one wire per slice of a universal binary and reports removed or absent fuses', () => {
    const wires = readFuseWires(electronBinary(SHIPPED, '1r00'))
    expect(wires).toHaveLength(2)
    expect(wires[1]).toMatchObject({
      length: 4,
      fuses: { enableCookieEncryption: 'removed', onlyLoadAppFromAsar: 'absent' }
    })
  })

  it('refuses a binary with no fuse wire', () => {
    expect(() => readFuseWires(Buffer.from('not electron'))).toThrow('no Electron fuse wire')
  })
})

describe('comparing the shipped wire with the declaration', () => {
  it('passes only when every declared fuse matches on every slice', () => {
    expect(fuseMismatches(readFuseWires(electronBinary(SHIPPED, SHIPPED)), SHIPPED_DECLARATION)).toEqual([])
    expect(fuseMismatches(readFuseWires(electronBinary(SHIPPED, QA_IDENTITY)), SHIPPED_DECLARATION)).toEqual([
      { slice: 1, fuse: 'enableNodeCliInspectArguments', declared: 'off', actual: 'on' }
    ])
  })

  it("flags Electron's defaults, which is what an unfused build ships", () => {
    const mismatches = fuseMismatches(readFuseWires(electronBinary(ELECTRON_DEFAULTS)), SHIPPED_DECLARATION)
    expect(mismatches.map((m: { fuse: string }) => m.fuse)).toEqual([
      'enableNodeOptionsEnvironmentVariable',
      'enableNodeCliInspectArguments',
      'enableEmbeddedAsarIntegrityValidation',
      'onlyLoadAppFromAsar'
    ])
  })
})

describe('the electronFuses declaration', () => {
  it('reads the block, ignoring comments and other keys', () => {
    const text = [
      'appId: com.example.app # trailing comment',
      'electronFuses:',
      '  # a comment inside the block',
      '  runAsNode: true',
      '',
      '  enableNodeCliInspectArguments: false  # off',
      'mac:',
      '  runAsNode: false'
    ].join('\n')
    expect(parseBuilderConfig(text, 'x.yml')).toEqual({
      extendsPath: null,
      fuses: { runAsNode: true, enableNodeCliInspectArguments: false }
    })
  })

  it.each([
    ['an inline value', 'electronFuses: {}'],
    ['a non-boolean value', 'electronFuses:\n  runAsNode: yes'],
    ['an unknown fuse', 'electronFuses:\n  runAsNodeX: true']
  ])('refuses %s rather than reading it as nothing declared', (_label, text) => {
    expect(() => parseBuilderConfig(text, 'x.yml')).toThrow('x.yml')
  })

  it('merges an extends chain resolved against the project directory, later files winning', () => {
    const project = temporaryDirectory()
    mkdirSync(join(project, 'build'))
    const base = 'electronFuses:\n  runAsNode: true\n  enableNodeCliInspectArguments: false\n'
    const variant = "extends: './base.yml'\nelectronFuses:\n  enableNodeCliInspectArguments: true\n"
    writeFileSync(join(project, 'base.yml'), base)
    writeFileSync(join(project, 'build', 'variant.yml'), variant)
    expect(declaredFuses('build/variant.yml', { projectDir: project })).toEqual({
      runAsNode: true,
      enableNodeCliInspectArguments: true
    })
  })

  it('refuses an extends cycle', () => {
    const project = temporaryDirectory()
    writeFileSync(join(project, 'a.yml'), 'extends: ./b.yml\n')
    writeFileSync(join(project, 'b.yml'), 'extends: ./a.yml\n')
    expect(() => declaredFuses('a.yml', { projectDir: project })).toThrow('extends cycle')
  })
})

describe('the declared fuses of the real build configs', () => {
  it('turns NODE_OPTIONS and --inspect off and asar integrity on for the shipped macOS build', () => {
    expect(declaredFuses('electron-builder.yml')).toEqual(SHIPPED_DECLARATION)
  })

  it('gives the Windows build the same fuses', () => {
    expect(declaredFuses('electron-builder.win.yml')).toEqual(SHIPPED_DECLARATION)
  })

  it('keeps only --inspect on for the QA-identity variant', () => {
    expect(declaredFuses('build/qa-identity.electron-builder.yml')).toEqual(QA_DECLARATION)
  })
})

describe('electron-fuses check', () => {
  it('passes a macOS app whose framework matches the config and writes the report', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const out = temporaryDirectory()
    const app = macApp(electronBinary(SHIPPED, SHIPPED))
    expect(runCheck([app, '--config', 'electron-builder.yml', '--out', out])).toBe(0)
    const report = JSON.parse(readFileSync(join(out, 'electron-fuses.json'), 'utf8'))
    expect(report).toMatchObject({ verdict: 'PASS', declared: SHIPPED_DECLARATION, mismatches: [] })
    expect(report.wires).toHaveLength(2)
  })

  it('fails an unfused Windows executable and names each differing fuse', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = temporaryDirectory()
    const exe = windowsExe(electronBinary(ELECTRON_DEFAULTS))
    expect(runCheck([exe, '--config', 'electron-builder.win.yml', '--out', out])).toBe(1)
    expect(JSON.parse(readFileSync(join(out, 'electron-fuses.json'), 'utf8')).verdict).toBe('FAIL')
    const annotations = errors.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith('::error::'))
    expect(annotations).toHaveLength(4)
  })

  it('passes the QA-identity app against its own config but not against the shipped one', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = macApp(electronBinary(QA_IDENTITY))
    expect(runCheck([app, '--config', 'build/qa-identity.electron-builder.yml', '--out', temporaryDirectory()])).toBe(0)
    expect(runCheck([app, '--config', 'electron-builder.yml', '--out', temporaryDirectory()])).toBe(1)
  })

  it('is a usage error when the config declares no fuses or the app is missing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const project = temporaryDirectory()
    writeFileSync(join(project, 'empty.yml'), 'appId: com.example.app\n')
    const exe = windowsExe(electronBinary(SHIPPED))
    expect(runCheck([exe, '--config', 'empty.yml', '--out', temporaryDirectory()], { projectDir: project })).toBe(2)
    const missing = join(project, 'missing.exe')
    expect(runCheck([missing, '--config', 'electron-builder.yml', '--out', temporaryDirectory()])).toBe(2)
  })
})

describe('electron-fuses set (harness copies)', () => {
  it('turns one fuse on in every slice and leaves the others alone', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const app = macApp(electronBinary(SHIPPED, SHIPPED))
    expect(runSet([app, 'enableNodeCliInspectArguments=true'])).toBe(0)
    expect(fuseMismatches(readFuseWires(readFileSync(join(app, FRAMEWORK))), QA_DECLARATION)).toEqual([])
  })

  it('writes a harness copy beside a Windows executable and leaves the shipped bytes untouched', () => {
    const shipped = electronBinary(SHIPPED)
    const exe = windowsExe(shipped)
    const copy = harnessCopy(exe, 'enableNodeCliInspectArguments', true, '-asr-gate')
    expect(copy).toBe(join(dirname(exe), 'Metis-asr-gate.exe'))
    expect(readFileSync(exe).equals(shipped)).toBe(true)
    expect(fuseMismatches(readFuseWires(readFileSync(copy)), QA_DECLARATION)).toEqual([])
    expect(() => harnessCopy(macApp(shipped), 'enableNodeCliInspectArguments', true, '-x')).toThrow('Windows .exe')
  })

  it('refuses a removed fuse and a malformed assignment', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => setFuse(electronBinary('1r00'), 'enableCookieEncryption', true)).toThrow('not present')
    expect(runSet([windowsExe(electronBinary(SHIPPED)), 'enableNodeCliInspectArguments=on'])).toBe(2)
  })
})

describe('the config after-pack hands to electron-builder', () => {
  it('maps declared fuses to their wire index and drops non-fuse options', () => {
    expect(flipFusesConfig({ ...SHIPPED_DECLARATION, resetAdHocDarwinSignature: true })).toEqual({
      version: '1',
      0: true,
      2: false,
      3: false,
      4: true,
      5: true
    })
  })
})
