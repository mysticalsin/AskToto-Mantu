import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../test-helpers/module-source'

/**
 * User-facing copy rule (DESIGN.md, bank-grade pass 2026-09-05): no em dashes in text the user sees.
 *
 * Comments are not copy, so they are stripped first. Everything that survives in these files is either a
 * string literal or JSX text, and both reach the screen. The list is the surfaces a buyer sees in the
 * first ten minutes: the bar, the answer/quick actions, Settings, Review, Recall, the Intelligence embed.
 * Add a file here when it becomes user-facing; do not add an exception list.
 */
const root = join(__dirname, '..', '..', '..')
const DIRECTORIES = ['src/renderer/src/components/history', 'src/renderer/src/features/settings', 'src/renderer/src/ui']
/** Module specifiers resolved by readModuleSource (FF-07: no `.tsx` path literals in a test that reads files). */
const MODULES = [
  './App',
  './components/Bar',
  './components/Settings',
  './components/Review',
  './components/RecallView',
  './components/UpcomingSection',
  './components/QuickActions',
  './components/Answer',
  './components/Copilot',
  './components/SignInWall',
  './components/LicenseGate',
  './components/AgendaView',
  './components/UpdateReadyToast',
  './components/MeetingOpenErrorToast',
  './components/OperatorGateToast',
  './components/NewMeetingToast',
  './components/VisibilityToast',
  './components/RecordingConsentReminder',
  './components/ShortcutFailureToast',
  './components/work-progress',
  './components/WorkProgressMeter',
  './components/BrainView',
  './components/BrainBars',
  './components/ImportQueue',
  './components/OverlayPeek',
  '../../../intelligence/src/App'
]

function listFiles(relDir: string): string[] {
  const absDir = join(root, relDir)
  if (!existsSync(absDir)) return []
  return readdirSync(absDir, { withFileTypes: true })
    .flatMap((entry) => {
      const rel = `${relDir}/${entry.name}`
      if (entry.isDirectory()) return listFiles(rel)
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [rel] : []
    })
    .sort()
}

const COPY_FILES: Array<{ label: string; specifier: string }> = [
  ...MODULES.map((specifier) => ({ label: specifier, specifier })),
  ...DIRECTORIES.flatMap(listFiles).map((rel) => ({
    label: rel,
    specifier: `../../../${rel.replace(/\.tsx?$/, '')}`
  }))
]

/** Remove block comments, JSX comments and line comments. Strings are left alone (a `//` inside a URL string
 *  only truncates that one line, which can hide an em dash but never invent one). */
export function stripComments(source: string): string {
  return (
    source
      // Keep the newlines of a block comment so reported line numbers match the real file.
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .replace(/([^:'"`])\/\/.*$/gm, '$1')
  )
}

describe('no em dashes in user-facing copy', () => {
  for (const { label: rel, specifier } of COPY_FILES) {
    it(rel, () => {
      const text = stripComments(readModuleSource(__dirname, specifier).text.replace(/\r\n/g, '\n'))
      const hits = text
        .split('\n')
        .map((line, i) => ({ line: i + 1, text: line.trim() }))
        .filter((l) => l.text.includes('—'))
      expect(hits, hits.map((h) => `${rel}:${h.line}: ${h.text.slice(0, 140)}`).join('\n')).toEqual([])
    })
  }
})
