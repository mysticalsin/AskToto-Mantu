import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// The gateway is exercised against a helper that is "present" on every host, so hosted ubuntu and windows runs
// check the same protocol. Nothing here spawns anything.
vi.mock('./mac-helper', () => ({
  macHelperPresent: () => true,
  macHelperPath: () => '/synthetic/metis-mac-helper',
  runHelperOnce: vi.fn(async () => null)
}))
import {
  AX_REFUSAL_REASONS,
  axInsertRequestBody,
  macAxFocusSnapshotSpawnSpec,
  macAxInsertSpawnSpec,
  parseAxFocusSnapshot,
  parseAxInsert
} from './mac-ax-helper'

const REPO_ROOT = process.cwd()
// A Windows checkout may carry CRLF; comments may name the calls the helper avoids.
const swiftSource = readFileSync(join(REPO_ROOT, 'native', 'mac-helper', 'main.swift'), 'utf8').replace(/\r\n/g, '\n')
const swift = swiftSource.replace(/\/\/[^\n]*/g, '')

function block(opening: string): string {
  const start = swift.indexOf(opening)
  expect(start, opening).toBeGreaterThan(-1)
  const close = swift.indexOf('\n}\n', start)
  expect(close).toBeGreaterThan(start)
  return swift.slice(start, close + 3)
}

function structFields(name: string): string[] {
  return [...block(`struct ${name}`).matchAll(/^ {4}(?:let|var) (\w+):/gm)].map((m) => m[1]!).sort()
}

const HASH = 'a'.repeat(64)
const snapshotJson = {
  status: 'ok',
  pid: 4242,
  bundleId: 'com.example.synthetic-editor',
  processStartMs: 1,
  windowId: 'wsynthetic01',
  role: 'AXTextArea',
  subrole: null,
  token: 'tok0123456789abcdef',
  secure: false,
  editable: true,
  terminal: false,
  valueHash: HASH,
  valueLength: 3,
  valueTooLarge: false,
  selection: { location: 3, length: 0 }
}
const insertJson = {
  outcome: 'verified',
  reason: null,
  method: 'ax',
  terminal: false,
  sanitized: false,
  textHash: HASH,
  textLength: 3,
  clipboard: 'not_used'
}

describe('ax helper gateway (G23)', () => {
  it('spawns two fixed argv entries: the dictated text and the field never travel in argv', () => {
    expect(macAxFocusSnapshotSpawnSpec()).toEqual({
      command: '/synthetic/metis-mac-helper',
      args: ['ax-focus-snapshot']
    })
    expect(macAxInsertSpawnSpec()).toEqual({ command: '/synthetic/metis-mac-helper', args: ['ax-insert'] })
  })

  it('writes the request as JSON for stdin and nowhere else', () => {
    const body = JSON.parse(
      axInsertRequestBody({
        pid: 4242,
        windowId: 'w1',
        token: 't1',
        valueHash: HASH,
        valueLength: 3,
        selectionLocation: 3,
        selectionLength: 0,
        text: 'synthetic words',
        allowPaste: true
      })
    )
    expect(Object.keys(body).sort()).toEqual(
      [
        'allowPaste',
        'pid',
        'selectionLength',
        'selectionLocation',
        'text',
        'token',
        'valueHash',
        'valueLength',
        'windowId'
      ].sort()
    )
  })

  it('accepts only the documented result shapes', () => {
    expect(parseAxFocusSnapshot(JSON.stringify(snapshotJson))).toMatchObject({ status: 'ok', pid: 4242 })
    expect(parseAxInsert(JSON.stringify(insertJson))).toMatchObject({ outcome: 'verified' })
    for (const bad of [
      '',
      'not json',
      '{}',
      JSON.stringify({ ...snapshotJson, valueHash: 'xyz' }),
      JSON.stringify({ ...snapshotJson, text: 'the field text' }).replace('"status":"ok"', '"status":"weird"'),
      JSON.stringify({ ...snapshotJson, token: 'has space' })
    ]) {
      expect(parseAxFocusSnapshot(bad)).toBeNull()
    }
    for (const bad of [
      '',
      '{}',
      JSON.stringify({ ...insertJson, outcome: 'maybe' }),
      JSON.stringify({ ...insertJson, reason: 'because' }),
      JSON.stringify({ ...insertJson, clipboard: 'mine' })
    ]) {
      expect(parseAxInsert(bad)).toBeNull()
    }
  })

  it('treats a key the Swift encoder omitted (a nil optional) as null', () => {
    expect(
      parseAxFocusSnapshot(
        JSON.stringify({ status: 'permission', secure: false, editable: false, terminal: false, valueTooLarge: false })
      )
    ).toMatchObject({ status: 'permission', pid: null, token: null, selection: null })
    expect(
      parseAxInsert(
        JSON.stringify({
          outcome: 'refused',
          reason: 'invalid_request',
          method: 'none',
          terminal: false,
          sanitized: false,
          textLength: 0,
          clipboard: 'not_used'
        })
      )
    ).toMatchObject({ textHash: null })
  })

  it('lists exactly the refusal reasons the Swift side can emit', () => {
    const emitted = new Set([...swift.matchAll(/reason: "(\w+)"/g)].map((m) => m[1]))
    expect([...emitted].sort()).toEqual([...AX_REFUSAL_REASONS].sort())
  })
})

describe('metis-mac-helper ax-*: privacy and safety by construction (G23)', () => {
  it('registers both subcommands and lists them in the usage line', () => {
    expect(swift).toMatch(/case "ax-focus-snapshot":/)
    expect(swift).toMatch(/case "ax-insert":/)
    expect(swift).toMatch(/usage: metis-mac-helper <[^>\n]*ax-focus-snapshot\|ax-insert/)
  })

  it('result structs match the TypeScript schemas field for field', () => {
    expect(structFields('AxSnapshotResult')).toEqual(Object.keys(snapshotJson).sort())
    expect(structFields('AxInsertResult')).toEqual(Object.keys(insertJson).sort())
  })

  it('never prompts: trust is probed with AXIsProcessTrusted only', () => {
    expect(swift).toMatch(/AXIsProcessTrusted\(\)/)
    expect(swift).not.toMatch(
      /AXIsProcessTrustedWithOptions|kAXTrustedCheckOptionPrompt|CGRequestPostEventAccess|CGRequestListenEventAccess/
    )
  })

  it('never prints the text of a field: the snapshot result has only a hash and a length', () => {
    const fields = structFields('AxSnapshotResult')
    expect(fields).toContain('valueHash')
    expect(fields.filter((f) => /^(value|text|selectedText|title)$/i.test(f))).toEqual([])
    expect(block('struct AxInsertResult')).not.toMatch(/let (text|value):/)
  })

  it('treats secure fields as secure and never reads their value', () => {
    const resolve = block('func resolveFocusedElement')
    expect(resolve).toMatch(/kAXSecureTextFieldSubrole/)
    expect(resolve).toMatch(/IsSecureEventInputEnabled\(\)/)
    // The value and the selection are read only inside the not-secure branch.
    const branch = resolve.slice(resolve.indexOf('if !secure {'))
    expect(branch).toMatch(/kAXValueAttribute/)
    expect(resolve.slice(0, resolve.indexOf('if !secure {'))).not.toMatch(
      /kAXValueAttribute as String\) as\? String|kAXSelectedTextRangeAttribute/
    )
  })

  it('compare-and-insert: re-resolves, refuses secure first, and compares process, window, element, value and selection', () => {
    const insert = block('func runAxInsert')
    expect(insert.indexOf('resolveFocusedElement()')).toBeGreaterThan(-1)
    expect(insert.indexOf('case .secure')).toBeLessThan(insert.indexOf('axSameTarget(snapshot, request)'))
    for (const check of [
      'axSameTarget(snapshot, request)',
      'sha256Hex(before) == request.valueHash',
      'before.utf16.count == request.valueLength',
      'selection.location == request.selectionLocation',
      'selection.length == request.selectionLength'
    ]) {
      expect(insert).toContain(check)
    }
    expect(block('func axSameTarget')).toMatch(
      /pid == request\.pid[\s\S]*windowId == request\.windowId[\s\S]*token == request\.token/
    )
  })

  it('reads its request from stdin and writes by replacing the selected text, then reads back', () => {
    const insert = block('func runAxInsert')
    expect(insert).toMatch(/FileHandle\.standardInput\.readDataToEndOfFile/)
    expect(insert).toMatch(/AXUIElementSetAttributeValue\(snapshot\.element, kAXSelectedTextAttribute/)
    expect(insert).toMatch(/axWaitForValue\(snapshot\.element, expectedHash: expectedHash/)
    expect(swift).not.toMatch(/CommandLine\.arguments\[\d\]\s*\)?\s*as?.*text/)
  })

  it('pastes only after Accessibility refused the write, and re-checks the field right before', () => {
    const insert = block('func runAxInsert')
    const ax = insert.indexOf('AXUIElementSetAttributeValue')
    const paste = insert.indexOf('NSPasteboard.general')
    expect(ax).toBeGreaterThan(-1)
    expect(paste).toBeGreaterThan(ax)
    // A success is final (verified or unverified): there is no path from it to the paste.
    expect(insert).toMatch(/if status == \.success \{[\s\S]*?command: "ax-insert"\)\n {8}\}/)
    expect(insert.slice(paste)).toMatch(/resolveFocusedElement\(\)/)
    expect(insert).toMatch(/guard request\.allowPaste/)
  })

  it('clipboard ownership: the change count is the token and a restore only happens while it still matches', () => {
    const insert = block('func runAxInsert')
    expect(insert).toMatch(/let token = pasteboard\.declareTypes\(/)
    expect(insert).toMatch(/pasteboard\.changeCount == token/)
    const restores = [...insert.matchAll(/restorePasteboard\(pasteboard, saved\)/g)]
    expect(restores.length).toBeGreaterThan(0)
    for (const restore of restores) {
      const before = insert.slice(Math.max(0, restore.index! - 120), restore.index)
      expect(before).toMatch(/if pasteboard\.changeCount == token \{\s*$/)
    }
    expect(insert).toMatch(/org\.nspasteboard\.ConcealedType/)
    // A clipboard that cannot be saved whole is never overwritten.
    expect(insert).toMatch(/guard let saved = savePasteboard\(pasteboard\)/)
  })

  it('terminal-safe sink: never Return, control characters stripped, terminals paste only', () => {
    const insert = block('func runAxInsert')
    expect(insert).toMatch(/let text = terminal \? terminalSafe\(request\.text\) : request\.text/)
    expect(insert).toMatch(/if !terminal, axSettable/)
    // Only one key is ever posted: V (virtualKey 9) with Command. No Return (36), keypad Enter (76) or newline text.
    expect([...insert.matchAll(/virtualKey: (\d+)/g)].map((m) => m[1])).toEqual(['9', '9'])
    expect(swift).not.toMatch(/kVK_Return|kVK_ANSI_KeypadEnter|keyboardSetUnicodeString|\.typeString|insertText/)
    const safe = block('func terminalSafe')
    for (const scalar of [
      '0x0A',
      '0x0D',
      '0x09',
      '0x00...0x1F',
      '0x7F...0x9F',
      '0x2028',
      '0x2029',
      '0x202A...0x202E'
    ]) {
      expect(safe).toContain(scalar)
    }
    expect(safe).toMatch(/while let last = result\.last, last == " "/)
  })

  it('classifies terminals by bundle id and by what the element says it is', () => {
    expect(swift).toContain('"com.apple.Terminal"')
    expect(swift).toContain('"com.googlecode.iterm2"')
    expect(block('func resolveFocusedElement')).toMatch(/description\.contains\("terminal"\)/)
  })
})
