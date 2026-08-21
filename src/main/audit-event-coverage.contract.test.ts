import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Audit-event coverage — CI/test-guard audit finding.
 *
 * logger.ts declares a closed `AuditEvent` union (~85 event types at the time this test was written) as
 * the single source of truth for what the audit log can record. Nothing previously forced every
 * declared event to actually be fired somewhere: a name can sit in the union, look load-bearing to a
 * reader ("surely something calls this"), and never once reach `auditLog()` — a "declared but never
 * fired" event that already happened once in this repo. That is a silent audit-trail gap: a reviewer
 * grepping logger.ts for what gets audited sees an event that in fact never appears in the log.
 *
 * This test parses the union member names straight out of logger.ts's source (no re-typed list to drift
 * from the real one) and asserts each appears at a real call site across src/main/**\/*.ts. A call site
 * is not required to be the literal `auditLog(` token: this codebase has two typed indirections —
 * `localAudit()` in llm/local-models.ts and the `deps.audit?.()` callback wired to auditLog in index.ts
 * and consumed by screen-preprocess.ts — so the scan matches any callee whose name contains "audit"
 * (case-insensitive), which covers `auditLog(`, `localAudit(`, and `audit?.(` alike without hand-listing
 * every wrapper. A genuinely dynamic call (`auditLog(someVariable, ...)`) would NOT be caught by this and
 * would report its event as an orphan — none exist in this codebase today (verified below), and if one is
 * introduced later it must be added to KNOWN_EXCEPTIONS with a reason, not silently ignored.
 *
 * KNOWN_EXCEPTIONS is frozen and reported, not swallowed: every event listed there was independently
 * grepped (including inside *.test.ts) and confirmed to have zero call sites anywhere in the repo, so
 * each is a genuine "declared but never fired" orphan today, not a scan blind spot. This test is meant to
 * make that visible, not hide it — do not add an event here without a comment stating that you checked.
 */

const root = join(__dirname, '..', '..')

const loggerSrc = readFileSync(join(root, 'src', 'main', 'logger.ts'), 'utf8')
const unionStart = loggerSrc.indexOf('export type AuditEvent =')
const unionEnd = loggerSrc.indexOf('\n\n// Lazy actor resolver', unionStart)
if (unionStart === -1) throw new Error('logger.ts no longer declares `export type AuditEvent =` — update this test')
if (unionEnd === -1 || unionEnd <= unionStart) {
  throw new Error("logger.ts's AuditEvent union no longer ends before the '// Lazy actor resolver' comment — update this test's slice")
}
const unionBlock = loggerSrc.slice(unionStart, unionEnd)

/** Every event name declared in the AuditEvent union, in source order. */
const DECLARED_EVENTS = [...unionBlock.matchAll(/'([a-zA-Z0-9._]+)'/g)].map((m) => m[1])

/**
 * Declared, never fired anywhere in src/main (production code or tests). Confirmed by direct grep, not
 * just by this test's own scan, before being frozen here — see the file-level comment above.
 */
const KNOWN_EXCEPTIONS = new Set<string>([
  // Only ever assigned by `dust.token.refreshed`/`dust.oauth.login` call sites nearby it in the union;
  // no code path constructs a Dust-setup-timeout condition and audits it. Orphaned, not dynamic.
  'dust.setup.timeout',
  // No transcript-import feature exists in src/main at all (grepped for any import-adjacent transcript
  // code) — this event predates or outlived a feature that is no longer in the tree.
  'transcript.imported',
  // index.ts's own comments say meeting-detect was removed from the app; this event is its last trace.
  'meeting.detect.degraded'
])

/** Tracked, non-test TypeScript source under src/main — the surface this scan checks for call sites. */
function mainSourceFiles(): string[] {
  const git = execSync('git ls-files -- src/main', { cwd: root, encoding: 'utf8' })
  return git
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
}

const combinedSource = mainSourceFiles()
  .map((f) => readFileSync(join(root, f), 'utf8'))
  .join('\n')

/** True when `event` is passed as a literal first argument to some `*audit*(` callee, any casing. */
function hasCallSite(event: string): boolean {
  const escaped = event.replace(/\./g, '\\.')
  const pattern = new RegExp(`[A-Za-z]*[Aa]udit[A-Za-z]*\\??\\.?\\(\\s*['"]${escaped}['"]`)
  return pattern.test(combinedSource)
}

describe('AuditEvent coverage — every declared event has a real call site', () => {
  it('parsed at least the events this test was written against (regression guard on the parser itself)', () => {
    expect(DECLARED_EVENTS.length).toBeGreaterThanOrEqual(73)
  })

  it('every KNOWN_EXCEPTIONS entry is actually declared (no stale entries)', () => {
    for (const ev of KNOWN_EXCEPTIONS) {
      expect(DECLARED_EVENTS, `KNOWN_EXCEPTIONS lists '${ev}', which is not in AuditEvent any more`).toContain(ev)
    }
  })

  it.each(DECLARED_EVENTS.filter((ev) => !KNOWN_EXCEPTIONS.has(ev)))(
    "'%s' is fired from a real auditLog-shaped call site in src/main",
    (event) => {
      expect(hasCallSite(event), `'${event}' is declared in AuditEvent but no call site fires it — add a call site or move it to KNOWN_EXCEPTIONS with a reason`).toBe(true)
    }
  )

  it('no KNOWN_EXCEPTIONS entry has quietly grown a real call site (would mean it should be un-excepted)', () => {
    const noLongerOrphaned = [...KNOWN_EXCEPTIONS].filter((ev) => hasCallSite(ev))
    expect(noLongerOrphaned, 'these events now have call sites — remove them from KNOWN_EXCEPTIONS').toEqual([])
  })
})
