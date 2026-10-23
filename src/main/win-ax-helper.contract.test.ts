import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Windows gateway is exercised on every host (hosted ubuntu, windows and macOS alike): nothing here spawns anything.
const run = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => null))
vi.mock('./mac-helper', () => ({
  macHelperPresent: () => false,
  macHelperPath: () => '/synthetic/metis-mac-helper',
  runHelperOnce: run
}))
import { WINDOWS_POWERSHELL } from './win-security'
import { parseAxFocusSnapshot, parseAxInsert } from './mac-ax-helper'
import {
  WIN_AX_SCRIPT_RELATIVE,
  winAxFocusSnapshotSpawnSpec,
  winAxHelperClient,
  winAxHelperPresent,
  winAxInsertSpawnSpec,
  winAxScriptPath
} from './win-ax-helper'
import { inertText } from './features/dictation/dictation-insert-win'

const REPO_ROOT = process.cwd()
// A Windows checkout may carry CRLF.
const scriptSource = readFileSync(join(REPO_ROOT, 'resources', 'win-ax', 'metis-win-ax.ps1'), 'utf8').replace(
  /\r\n/g,
  '\n'
)
// Comments may name the calls the script avoids.
const script = scriptSource.replace(/^\s*#.*$/gm, '')
const swiftSource = readFileSync(join(REPO_ROOT, 'native', 'mac-helper', 'main.swift'), 'utf8').replace(/\r\n/g, '\n')

const locator = { platform: 'win32' as const, resourcesPath: 'C:\\synthetic\\resources', exists: () => true }
const HASH = 'a'.repeat(64)

describe('win-ax-helper spawn specs (G24)', () => {
  it('runs the pinned System32 powershell with -File and exactly one argv word; the text is never argv', () => {
    const snapshot = winAxFocusSnapshotSpawnSpec(locator)
    const insert = winAxInsertSpawnSpec(locator)
    expect(snapshot?.command).toBe(WINDOWS_POWERSHELL)
    expect(WINDOWS_POWERSHELL).toMatch(/System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/)
    expect(snapshot?.args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'])
    expect(snapshot?.args.at(-1)).toBe('ax-focus-snapshot')
    expect(insert?.args.at(-1)).toBe('ax-insert')
    expect(snapshot?.args).toHaveLength(7)
    expect(insert?.args).toHaveLength(7)
    expect(snapshot?.args[5]).toContain('metis-win-ax.ps1')
    expect(snapshot?.args).not.toContain('-Command')
    expect(snapshot?.args).not.toContain('-EncodedCommand')
  })

  it('has no spec off Windows or when the packaged script is missing', () => {
    expect(winAxScriptPath({ ...locator, platform: 'darwin' })).toBeNull()
    expect(winAxScriptPath({ ...locator, platform: 'linux' })).toBeNull()
    expect(winAxScriptPath({ ...locator, exists: () => false })).toBeNull()
    expect(winAxScriptPath({ ...locator, resourcesPath: '' })).toBeNull()
    expect(winAxFocusSnapshotSpawnSpec({ ...locator, exists: () => false })).toBeNull()
    expect(winAxHelperPresent({ ...locator, platform: 'linux' })).toBe(false)
    expect(winAxHelperPresent(locator)).toBe(true)
    expect(WIN_AX_SCRIPT_RELATIVE).toMatch(/win-ax[\\/]metis-win-ax\.ps1$/)
  })
})

describe('win-ax-helper client (G24)', () => {
  beforeEach(() => run.mockClear())

  it('writes the insert request, text included, to stdin only', async () => {
    const request = {
      pid: 4242,
      windowId: 'w100',
      token: '42.100.4',
      valueHash: HASH,
      valueLength: 3,
      selectionLocation: 3,
      selectionLength: 0,
      text: 'synthetic dictated sentence',
      allowPaste: true
    }
    await winAxHelperClient.insert(request)
    expect(run).toHaveBeenCalledTimes(1)
    const [spec, , , input] = run.mock.calls[0] as unknown as [{ args: string[] } | null, unknown, number, string]
    expect(JSON.parse(input)).toMatchObject({ text: 'synthetic dictated sentence', pid: 4242 })
    expect(JSON.stringify(spec)).not.toContain('synthetic dictated')
  })
})

describe('the script speaks the macOS helper JSON (G24 parity)', () => {
  const snapshot = {
    status: 'ok',
    pid: 4242,
    bundleId: 'win:notepad',
    processStartMs: 1_700_000_000_000,
    windowId: 'w263950',
    role: 'Edit',
    subrole: null,
    token: '42.263950.4.1',
    secure: false,
    editable: true,
    terminal: false,
    valueHash: HASH,
    valueLength: 3,
    valueTooLarge: false,
    selection: { location: 3, length: 0 }
  }

  it('accepts a Windows snapshot and a permission/no_focus answer with null fields', () => {
    expect(parseAxFocusSnapshot(JSON.stringify(snapshot))).toMatchObject({
      bundleId: 'win:notepad',
      token: '42.263950.4.1'
    })
    const empty = {
      ...snapshot,
      pid: null,
      bundleId: null,
      processStartMs: null,
      windowId: null,
      role: null,
      token: null,
      valueHash: null,
      valueLength: null,
      selection: null,
      editable: false
    }
    expect(parseAxFocusSnapshot(JSON.stringify({ ...empty, status: 'permission' }))?.status).toBe('permission')
    expect(parseAxFocusSnapshot(JSON.stringify({ ...empty, status: 'no_focus' }))?.status).toBe('no_focus')
  })

  it('the script emits exactly the snapshot and insert keys the macOS helper emits', () => {
    const emitted = (block: string): string[] => {
      const body = /\[ordered\]@\{([\s\S]*?)\n\s*\}/.exec(block)?.[1] ?? ''
      return [...body.matchAll(/\b(\w+) = /g)].map((m) => m[1]!).sort()
    }
    const snapshotBlock = /function Emit-Snapshot[\s\S]*?\n}\n/.exec(script)?.[0] ?? ''
    const insertBlock = /function Emit-Insert[\s\S]*?\n}\n/.exec(script)?.[0] ?? ''
    const keys = (name: string): string[] => {
      const start = swiftSource.indexOf(`struct ${name}`)
      const close = swiftSource.indexOf('\n}\n', start)
      return [...swiftSource.slice(start, close).matchAll(/^ {4}(?:let|var) (\w+):/gm)].map((m) => m[1]!).sort()
    }
    // Swift's snapshot struct names its fields as in the JSON; the insert struct likewise.
    expect(emitted(snapshotBlock)).toEqual(Object.keys(snapshot).sort())
    expect(emitted(insertBlock)).toEqual(
      ['clipboard', 'method', 'outcome', 'reason', 'textHash', 'textLength', 'sanitized', 'terminal'].sort()
    )
    expect(keys('AxInsertResult')).toEqual(emitted(insertBlock))
  })

  it.each([
    ['verified', null, 'ax'],
    ['unverified', null, 'ax'],
    ['refused', 'secure_field', 'none'],
    ['refused', 'target_changed', 'none'],
    ['refused', 'permission', 'none'],
    ['unsupported', 'unsupported', 'none']
  ])('accepts an insert answer %s/%s', (outcome, reason, method) => {
    const body = {
      outcome,
      reason,
      method,
      terminal: false,
      sanitized: false,
      textHash: outcome === 'refused' ? null : HASH,
      textLength: 3,
      clipboard: 'not_used'
    }
    expect(parseAxInsert(JSON.stringify(body))).toMatchObject({ outcome, reason, method, clipboard: 'not_used' })
  })
})

describe('the script keeps the insertion invariants (G24)', () => {
  it('uses UI Automation and Unicode SendInput, never the clipboard, never Enter', () => {
    expect(script).toContain('UIAutomationClient')
    expect(script).toContain('0x0004') // KEYEVENTF_UNICODE
    expect(script).toContain('SendInput')
    expect(script).not.toMatch(
      /Set-Clipboard|Get-Clipboard|Windows\.Forms|SendKeys|VK_RETURN|\{ENTER\}|keybd_event|WScript/
    )
    expect(script).not.toMatch(/wVk = (?!0;)/)
  })

  it('reads the request from stdin and nothing from argv but the command word', () => {
    expect(script).toContain('[Console]::OpenStandardInput()')
    expect(script).toMatch(/param\(\[Parameter\(Position = 0\)\]\[string\]\$Command = ''\)/)
    expect(script).not.toMatch(/\$args\b/)
  })

  it('never writes a field value to stdout and never reads a password field', () => {
    expect(script).toMatch(/if \(\$s\.secure\) \{ return \$s \}/)
    expect(script.indexOf('if ($s.secure)')).toBeLessThan(script.indexOf('Read-Field $element'))
    // $text / .text is internal only: no Emit call receives it.
    for (const call of script.match(/Emit(?:-Snapshot|-Insert)? [^\n]*/g) ?? [])
      expect(call).not.toMatch(/\.text\b|\$text\b(?!Hash|\.Length)/)
  })

  it('refuses secure first, then compares identity and content, before any key is sent', () => {
    const compare = script.slice(script.indexOf('function Compare-Target'), script.indexOf('$first = Resolve-Focus'))
    expect(compare.indexOf('$s.secure')).toBeLessThan(compare.indexOf('$s.pid -ne $reqPid'))
    expect(compare.indexOf("'secure_field'")).toBeLessThan(compare.indexOf('$s.valueHash'))
    for (const needle of [
      '$reqPid',
      '$req.windowId',
      '$req.token',
      '$req.valueHash',
      '$reqLen',
      '$reqLoc',
      '$reqSelLen'
    ]) {
      expect(compare).toContain(needle)
    }
    const firstSend = script.indexOf('[MetisWin]::SendUnits($chunk)')
    expect(script.indexOf('$last = Resolve-Focus')).toBeLessThan(firstSend)
    expect(script.lastIndexOf('Compare-Target $last')).toBeLessThan(firstSend)
    expect(script.indexOf('[MetisWin]::ModifiersDown()')).toBeLessThan(script.indexOf('$last = Resolve-Focus'))
  })

  it('refuses a higher-integrity (elevated) target as permission, and a blocked send as permission', () => {
    expect(script).toContain('IntegrityRid')
    expect(script).toMatch(
      /\$target -lt 0 -or \(\$own -ge 0 -and \$target -gt \$own\)\) \{ return @\{ kind = 'permission'/
    )
    expect(script).toMatch(/if \(-not \$acceptedAny\) \{[\s\S]*?'refused' 'permission'/)
  })

  it('reports a partial or terminal send as unverified, and verifies only by the expected value hash', () => {
    expect(script).toMatch(/if \(-not \$complete\) \{ Emit-Insert 'unverified'/)
    expect(script).toMatch(/if \(\$terminal\) \{ Emit-Insert 'unverified'/)
    expect(script).toContain('$now.valueHash -eq (Sha256Hex $expected)')
  })

  it('an exception after the first key reports unverified, never unsupported', () => {
    const catchBlock = script.slice(script.lastIndexOf('} catch {'))
    expect(catchBlock).toMatch(/\$script:SentAny\) \{ Emit-Insert 'unverified'/)
  })

  it('classifies Windows Terminal, conhost, PowerShell ISE and cmd as terminals', () => {
    for (const name of ['windowsterminal', 'conhost', 'powershell_ise', 'cmd', 'pwsh', 'openconsole'])
      expect(script).toContain(`'${name}'`)
    for (const cls of ['CASCADIA_HOSTING_WINDOW_CLASS', 'ConsoleWindowClass', 'PseudoConsoleWindow'])
      expect(script).toContain(`'${cls}'`)
  })

  it('sanitizes with the same code points as inertText (the TypeScript twin)', () => {
    const fn = /function Get-InertText[\s\S]*?\n}\n/.exec(script)?.[0] ?? ''
    for (const point of [
      '0x0A',
      '0x0D',
      '0x09',
      '0x0B',
      '0x0C',
      '0x85',
      '0x2028',
      '0x2029',
      '0x1F',
      '0x7F',
      '0x9F',
      '0x200E',
      '0x200F',
      '0x202A',
      '0x202E',
      '0x2066',
      '0x2069',
      '0xD800',
      '0xDBFF',
      '0xDC00',
      '0xDFFF'
    ]) {
      expect(fn.toUpperCase()).toContain(point.toUpperCase())
    }
    expect(inertText('a\r\nb\tc', false)).toBe('a  b c')
    expect(inertText('x\u202Ey\u0007z\u0085', true)).toBe('xyz')
    expect(inertText('ok \u2028', true)).toBe('ok')
    expect(inertText('ok ', false)).toBe('ok ')
    expect(inertText('\ud83d\ude00 \ud83d', false)).toBe('\ud83d\ude00 ')
  })
})

describe('the script ships (G24)', () => {
  it('is staged and required by the lean Windows package', () => {
    const stage = readFileSync(join(REPO_ROOT, 'scripts', 'prepare-lean-package-stage.mjs'), 'utf8')
    const check = readFileSync(join(REPO_ROOT, 'scripts', 'check-lean-package.mjs'), 'utf8')
    const builder = readFileSync(join(REPO_ROOT, 'electron-builder.yml'), 'utf8')
    expect(stage).toContain("copyTree('resources/win-ax', 'win-ax')")
    expect(check).toContain("'win-ax/metis-win-ax.ps1'")
    expect(builder).toMatch(/from: resources\/win-ax\s+to: win-ax/)
  })
})
