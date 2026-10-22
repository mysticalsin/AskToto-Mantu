import type { Settings } from '@shared/ipc'
import { listEntities, readDeal, readPerson, slugify } from './store'

// ── Lint (Karpathy's "health check" pass — flag, never auto-fix) ─────────────

/** One lintBrainDetailed finding, entity-linked so a consumer (brain:attention, Task MI-3) can offer a
 *  jump action straight to the record page — `lintBrain`'s plain string[] (idx.warnings, unchanged since
 *  before MI-3) throws that linkage away, keeping only `detail`. */
export interface LintFinding {
  entityKind: 'person' | 'deal'
  id: string
  label: string
  detail: string
}

export function lintBrainDetailed(s: Settings): LintFinding[] {
  const findings: LintFinding[] = []
  for (const slug of listEntities(s, 'person')) {
    const p = readPerson(s, slug)
    if (!p) continue
    // A2 fix (D8): the old check derived "orgs" from the single p.account field mapped once per
    // stance_trail entry, so it could never produce more than one distinct value — it never fired.
    // org_provenance's current value + its full superseded history (see mergeExtraction's org merge)
    // is the actual per-meeting account association record; dedupe by SLUG (not raw text) since two
    // spellings of the same account name must not falsely count as "multiple accounts".
    const bySlug = new Map<string, string>() // account slug -> a display value seen for it
    const consider = (v: string | null | undefined): void => {
      if (v && !bySlug.has(slugify(v))) bySlug.set(slugify(v), v)
    }
    consider(p.org_provenance?.value)
    for (const prior of p.org_provenance?.superseded ?? []) consider(prior.value)
    if (bySlug.size > 1) {
      findings.push({
        entityKind: 'person',
        id: slug,
        label: p.name,
        detail: `Person "${p.name}" is linked to multiple accounts: ${[...bySlug.values()].join(', ')}`
      })
    }
  }
  for (const slug of listEntities(s, 'deal')) {
    const d = readDeal(s, slug)
    if (!d) continue
    if (d.outcome !== 'open' && d.win_likelihood_band) {
      findings.push({
        entityKind: 'deal',
        id: slug,
        label: d.name,
        detail: `Deal "${d.name}" is ${d.outcome} but still carries a live win-likelihood band`
      })
    }
  }
  return findings
}

/** Plain-string lint warnings (idx.warnings — the shape the dashboard and index.json have always used).
 *  A thin projection over lintBrainDetailed so there is exactly one implementation of the checks
 *  themselves; behavior/wording is unchanged from before Task MI-3. */
export function lintBrain(s: Settings): string[] {
  return lintBrainDetailed(s).map((f) => f.detail)
}
