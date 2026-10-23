/**
 * Windows dictation ports (G24): UI Automation focus binding and SendInput insertion behind the SAME port, outcome
 * types, compare-and-insert protocol and audit as macOS (dictation-insert-mac.ts). Nothing is forked: this module only
 * supplies the Windows helper client and presence check, and the shared adapter does the rest, so a protocol change in
 * G23 lands here without an edit.
 *
 * Windows specifics, all enforced by resources/win-ax/metis-win-ax.ps1 and pinned by its contract tests:
 * - the focused element is bound by process id, top-level window handle, UI Automation runtime id (the opaque token)
 *   and the field's value hash, length and selection; the text of a field never crosses;
 * - a password field (IsPassword) is refused first and never read;
 * - text is typed as KEYEVENTF_UNICODE input (no clipboard), line breaks, control and bidi characters are made inert
 *   for every target (a Unicode packet carrying a line feed may submit a form) and Enter is never sent;
 * - a target in a higher integrity level (an elevated window: UIPI would silently drop the input) is refused as
 *   `permission`; a terminal cannot be read back, so it is `inserted_unverified`.
 */
import type { DictationHostPorts } from './dictation-ports'
import { winAxHelperClient, winAxHelperPresent } from '../../win-ax-helper'
import type { AxHelperClient } from '../../mac-ax-helper'
import { createMacDictationPorts, type MacInsertAudit } from './dictation-insert-mac'

export type WinInsertAudit = MacInsertAudit

export interface WinDictationPortsDeps {
  client?: AxHelperClient
  helperPresent?: () => boolean
  platform?: NodeJS.Platform
  now?: () => number
  audit?: (detail: WinInsertAudit) => void
}

export function createWinDictationPorts(deps: WinDictationPortsDeps = {}): DictationHostPorts {
  const platform = deps.platform ?? process.platform
  return createMacDictationPorts({
    client: deps.client ?? winAxHelperClient,
    platform,
    expectedPlatform: 'win32',
    helperPresent: deps.helperPresent ?? (() => winAxHelperPresent({ platform })),
    now: deps.now,
    audit: deps.audit
  })
}

/**
 * The text the script will type: C0/DEL/C1 controls, bidi controls and unpaired surrogates dropped, line and
 * paragraph separators, tabs and line breaks turned into a space, trailing blanks trimmed for a terminal. The
 * authority is the script's Get-InertText; this is its TypeScript twin, kept in step by a contract test, used to
 * predict the sanitized text hash.
 */
export function inertText(text: string, trimTrailing: boolean): string {
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    if (
      c === 0x0a ||
      c === 0x0d ||
      c === 0x09 ||
      c === 0x0b ||
      c === 0x0c ||
      c === 0x85 ||
      c === 0x2028 ||
      c === 0x2029
    ) {
      out += ' '
      continue
    }
    if (
      c <= 0x1f ||
      (c >= 0x7f && c <= 0x9f) ||
      c === 0x200e ||
      c === 0x200f ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069)
    ) {
      continue
    }
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i]! + text[i + 1]!
        i += 1
      }
      continue
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue
    out += text[i]!
  }
  return trimTrailing ? out.replace(/ +$/, '') : out
}
