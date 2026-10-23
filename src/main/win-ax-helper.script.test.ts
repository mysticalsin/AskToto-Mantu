import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WINDOWS_POWERSHELL } from './win-security'

// Runs the real Windows PowerShell on the shipped script (G24). Declared in scripts/check-skipped-tests.mjs REASONS:
// it can only run on a Windows host, and hosted windows-latest always has powershell.exe.
const onWindows = process.platform === 'win32'
const SCRIPT = join(process.cwd(), 'resources', 'win-ax', 'metis-win-ax.ps1')
const BASE = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']

describe('metis-win-ax.ps1 under the real Windows PowerShell (G24)', () => {
  it.skipIf(!onWindows)('parses with no ParseError', () => {
    // -Command would append trailing arguments to the command text, so the path travels in the environment and
    // the command as -EncodedCommand (UTF-16LE base64), which no Windows argument quoting can alter.
    const command =
      '$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($env:METIS_PARSE_TARGET,[ref]$t,[ref]$e);' +
      "if($e.Count -gt 0){$e|ForEach-Object{[Console]::Error.WriteLine($_.Message+' @'+$_.Extent.StartLineNumber)};exit 1};exit 0"
    const encoded = Buffer.from(command, 'utf16le').toString('base64')
    const result = spawnSync(WINDOWS_POWERSHELL, [...BASE, '-EncodedCommand', encoded], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, METIS_PARSE_TARGET: SCRIPT }
    })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it.skipIf(!onWindows)('an invalid command word exits non-zero with a JSON refusal and needs no UI Automation', () => {
    const result = spawnSync(WINDOWS_POWERSHELL, [...BASE, '-File', SCRIPT, 'not-a-command'], {
      encoding: 'utf8',
      timeout: 60_000
    })
    expect(result.status).not.toBe(0)
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      outcome: 'refused',
      reason: 'invalid_request',
      method: 'none'
    })
  })
})
