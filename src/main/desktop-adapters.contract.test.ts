import { describe, expect, it } from 'vitest'
import { DESKTOP_ADAPTER_IDS } from '../shared/desktop-actions'
import { readModuleSource } from '../test-helpers/module-source'

const rawSrc = readModuleSource(__dirname, './desktop-adapters').text
/** Code only: the header comment explains what is forbidden, so it names the forbidden words. */
const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const exec = readModuleSource(__dirname, './infra/process/desktop-exec').text
const targets = readModuleSource(__dirname, './voice/safe-targets').text

describe('Cap2 desktop-adapters contract', () => {
  it('implements every allowlisted adapter id', () => {
    for (const id of DESKTOP_ADAPTER_IDS) {
      expect(src).toContain(`'${id}'`)
    }
  })

  it('does not silently swap Arc to Chrome/Edge on failure', () => {
    expect(src).toMatch(/No silent browser swap|No silent Edge\/Chrome swap/)
  })

  it('keeps photo capture local (no decide upload path)', () => {
    expect(src).toMatch(/never sent to \/v1\/decide|local only/i)
    expect(src).not.toMatch(/typesafe\.ai/)
  })

  it('uses open/osascript on darwin: no new mic stack', () => {
    expect(src).toContain('/usr/bin/open')
    expect(src).toContain('/usr/bin/osascript')
    expect(src).not.toMatch(/apple-speech|cloud-stt|MediaRecorder/)
  })

  it('starts no process itself: every spawn goes through infra/process (FF-10)', () => {
    expect(src).not.toMatch(/from 'node:child_process'|require\(['"](?:node:)?child_process/)
    expect(src).toContain("from './infra/process/desktop-exec'")
  })

  it('never builds a shell or script string from a request argument', () => {
    // Every executable is a fixed literal or a pinned SystemRoot path; there is no shell in any branch.
    expect(src).not.toMatch(/cmd\.exe|powershell|\/bin\/(?:ba|z)?sh|do shell script|shell:\s*true/i)
    // AppleScript is a static array of literal lines. A request argument is never interpolated into one.
    expect(src).toContain('CREATE_NOTE_SCRIPT_LINES')
    expect(src).not.toMatch(/-e['"]?,\s*`/)
    const scriptLines = src.slice(
      src.indexOf('CREATE_NOTE_SCRIPT_LINES = ['),
      src.indexOf('] as const', src.indexOf('CREATE_NOTE_SCRIPT_LINES = ['))
    )
    expect(scriptLines).not.toContain('${')
    expect(scriptLines).toContain('on run argv')
    // The person's text reaches osascript as argv after a fixed non-dash marker, never as an option.
    expect(src).toContain("const ARGV_MARKER = 'metis-voice-argv'")
    expect(src).toMatch(/args\.push\(ARGV_MARKER, req\.args\.title, noteHtml\(/)
  })

  it('hands the browser only allowlisted https URLs', () => {
    expect(src).toContain('isAllowedBrowserUrl(url)')
    expect(src).not.toMatch(/https?:\/\/[^'"`\s]*\$\{/)
    expect(targets).toContain("const GOOGLE_HOST = 'www.google.com'")
    expect(targets).toContain("export const X_URL = 'https://x.com'")
  })

  it('validates every request through the catalog before any branch runs', () => {
    expect(src).toContain('validateDesktopRequest(request)')
    expect(src.indexOf('validateDesktopRequest(request)')).toBeLessThan(src.indexOf('executeMac(ctx)'))
  })

  it('pins Windows shell targets to a SystemRoot executable instead of PATH', () => {
    expect(src).toContain("const WINDOWS_ROOT = process.env.SystemRoot || 'C:\\\\Windows'")
    expect(src).toContain("win32.join(WINDOWS_ROOT, 'explorer.exe')")
    expect(src).not.toMatch(/run\(['"](?:notepad|arc)\.exe/)
  })

  it('the process helper pins shell off and never forwards a thrown value', () => {
    expect(exec).toMatch(/shell: false/g)
    expect(exec).not.toMatch(/shell:\s*true/)
    expect(exec).not.toMatch(/\.message|String\(error\)|error\.stack/)
  })
})
