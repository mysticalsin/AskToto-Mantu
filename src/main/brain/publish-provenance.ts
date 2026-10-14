import { basename } from 'node:path'
import { RENDERABLE_PROVENANCE_STATES, type ProvenanceState, type Confidence, type ProvenantField } from '@shared/brain'
import { slugify } from './store'

function passesSoftGate(state: ProvenanceState, confidence: Confidence): boolean {
  return RENDERABLE_PROVENANCE_STATES.has(state) || (state === 'extracted' && confidence === 'EXTRACTED')
}

interface RenderInfo<T> {
  renders: boolean
  value?: T
  sourceFile?: string
  date?: string
}

export const NOT_CONFIDENTIAL = (sf: string, confidential: Set<string>): boolean => !sf || !confidential.has(sf)

/** Non-numeric provenant fields (role/org/sector/stage/win_likelihood_band/velocity): renders when the
 *  live value passes the soft gate (verified/pinned/edited, OR extracted+EXTRACTED). When the live
 *  value's own source meeting is confidential, falls back to the newest non-confidential entry in
 *  `superseded` — filtering the provenance chain at RENDER time only, per the MI-5 brief; the brain
 *  store itself is never mutated. A superseded entry carries no `state` (see SupersededEntry in
 *  store.ts), so it is always treated as machine-extracted tier, gated by its own recorded confidence. */
export function renderNonNumeric<T>(field: ProvenantField<T> | undefined, confidential: Set<string>): RenderInfo<T> {
  if (!field) return { renders: false }
  if (NOT_CONFIDENTIAL(field.source_file, confidential)) {
    return {
      renders: passesSoftGate(field.state, field.confidence),
      value: field.value,
      sourceFile: field.source_file,
      date: field.date
    }
  }
  for (const e of field.superseded) {
    if (!NOT_CONFIDENTIAL(e.source_file, confidential)) continue
    return {
      renders: passesSoftGate('extracted', e.confidence ?? 'INFERRED'),
      value: e.value,
      sourceFile: e.source_file,
      date: e.date
    }
  }
  return { renders: false }
}

/** Numeric provenant fields (deal amount/close_date) — the STRICT MI-4 gate: renders ONLY when
 *  state ∈ {verified, pinned, edited}, never merely EXTRACTED confidence. When the live value's source
 *  meeting is confidential, this NEVER falls back into `superseded` — a superseded entry carries no
 *  `state` at all (see SupersededEntry), so there is no way to know a historical sighting was ever
 *  independently verified; guessing would be exactly the silent-unverified-number leak this gate exists
 *  to prevent. A confidential-sourced current number renders "not established" instead. */
export function renderNumeric<T>(field: ProvenantField<T> | undefined, confidential: Set<string>): RenderInfo<T> {
  if (!field) return { renders: false }
  if (!NOT_CONFIDENTIAL(field.source_file, confidential)) return { renders: false }
  return {
    renders: RENDERABLE_PROVENANCE_STATES.has(field.state),
    value: field.value,
    sourceFile: field.source_file,
    date: field.date
  }
}

function citeSource(sourceFile?: string, date?: string): string {
  if (!sourceFile) return date ? `edited by you (${date})` : 'edited by you'
  const slug = slugify(basename(sourceFile))
  return `[${sourceFile}${date ? `, ${date}` : ''}](../meetings/${slug}.md)`
}

export function factRow<T>(label: string, info: RenderInfo<T>, format: (v: T) => string): string {
  if (!info.renders || info.value === undefined || info.value === null) {
    return `| ${label} | not established | — |`
  }
  return `| ${label} | ${format(info.value)} | ${citeSource(info.sourceFile, info.date)} |`
}

export function plainFactRow(label: string, value: string): string {
  return `| ${label} | ${value} | — |`
}

// ── Changelog (superseded history, capped 10, confidential entries excluded) ───────────────────────────
