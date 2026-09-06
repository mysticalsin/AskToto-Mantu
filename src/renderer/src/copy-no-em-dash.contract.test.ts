import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * User-facing copy rule (DESIGN.md, bank-grade pass 2026-09-05): no em dashes in text the user sees.
 *
 * Comments are not copy, so they are stripped first. Everything that survives in these files is either a
 * string literal or JSX text, and both reach the screen. The list is the surfaces a buyer sees in the
 * first ten minutes: the bar, the answer/quick actions, Settings, Review, Recall, the Intelligence embed.
 * Add a file here when it becomes user-facing; do not add an exception list.
 */
const root = join(__dirname, '..', '..', '..')
const FILES = [
  'src/renderer/src/App.tsx',
  'src/renderer/src/components/Bar.tsx',
  'src/renderer/src/components/Settings.tsx',
  'src/renderer/src/components/Review.tsx',
  'src/renderer/src/components/RecallView.tsx',
  'src/renderer/src/components/QuickActions.tsx',
  'src/renderer/src/components/Answer.tsx',
  'src/renderer/src/components/Copilot.tsx',
  'src/renderer/src/components/SignInWall.tsx',
  'src/renderer/src/components/LicenseGate.tsx',
  'src/renderer/src/components/AgendaView.tsx',
  'src/renderer/src/components/UpdateReadyToast.tsx',
  'src/renderer/src/components/MeetingOpenErrorToast.tsx',
  'src/renderer/src/components/OperatorGateToast.tsx',
  'src/renderer/src/components/NewMeetingToast.tsx',
  'src/renderer/src/components/VisibilityToast.tsx',
  'src/renderer/src/components/RecordingConsentReminder.tsx',
  'intelligence/src/App.tsx'
]

/** Remove block comments, JSX comments and line comments. Strings are left alone (a `//` inside a URL string
 *  only truncates that one line, which can hide an em dash but never invent one). */
export function stripComments(source: string): string {
  return source
    // Keep the newlines of a block comment so reported line numbers match the real file.
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1')
}

describe('no em dashes in user-facing copy', () => {
  for (const rel of FILES) {
    it(rel, () => {
      const text = stripComments(readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n'))
      const hits = text
        .split('\n')
        .map((line, i) => ({ line: i + 1, text: line.trim() }))
        .filter((l) => l.text.includes('—'))
      expect(hits, hits.map((h) => `${rel}:${h.line}: ${h.text.slice(0, 140)}`).join('\n')).toEqual([])
    })
  }
})
