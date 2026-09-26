/**
 * Métis 2.0 Cap 2 — desktop adapter allowlist (video sequence).
 * Extend EXISTING voice/actions path — do NOT abuse quick-actions.ts (LLM Ask chips).
 * Contracts: METIS-2.0-CONTRACTS-CAP1.md + WAKE-WORD-LOCK.md
 */

export const DESKTOP_ADAPTER_IDS = [
  'desktop.open_notes',
  'desktop.create_note',
  'desktop.open_arc',
  'desktop.google_search',
  'desktop.open_x',
  'desktop.photo_booth_capture'
] as const

export type DesktopAdapterId = (typeof DESKTOP_ADAPTER_IDS)[number]

export type DesktopActionArgs = {
  'desktop.open_notes': Record<string, never>
  'desktop.create_note': { title: string }
  'desktop.open_arc': Record<string, never>
  'desktop.google_search': { q: string }
  'desktop.open_x': Record<string, never>
  'desktop.photo_booth_capture': Record<string, never>
}

export type DesktopActionRequest = {
  [K in DesktopAdapterId]: { id: K; args: DesktopActionArgs[K] }
}[DesktopAdapterId]

export type DesktopActionOutcome = 'verified' | 'unknown' | 'failed' | 'cancelled' | 'unsupported'

export interface DesktopActionResult {
  id: DesktopAdapterId
  ok: boolean
  outcome: DesktopActionOutcome
  detail?: string
  /** True when the preferred app was missing and we refused a silent substitute. */
  preferredMissing?: boolean
}

/** Windows disclosure — never silent substitute for Mac preferred apps. */
export const WINDOWS_DESKTOP_EQUIVALENTS: Record<
  DesktopAdapterId,
  { preferred: string; note: string }
> = {
  'desktop.open_notes': {
    preferred: 'Sticky Notes (or Notepad)',
    note: 'Mac Notes has no silent Win twin; fail visibly if Sticky Notes / Notepad unavailable.'
  },
  'desktop.create_note': {
    preferred: 'Sticky Notes new note / Notepad new file titled hello',
    note: 'Title must be exactly hello when requested; no silent rename.'
  },
  'desktop.open_arc': {
    preferred: 'Arc (if installed)',
    note: 'Do NOT silently swap to Edge/Chrome. Disclose missing Arc.'
  },
  'desktop.google_search': {
    preferred: 'Default browser Google search',
    note: 'Open Google search URL; if Arc was the Mac target, Win uses default https handler only after disclosing Arc absence for open_arc.'
  },
  'desktop.open_x': {
    preferred: 'Default browser → https://x.com',
    note: 'Navigate only; never compose/post.'
  },
  'desktop.photo_booth_capture': {
    preferred: 'Windows Camera app',
    note: 'Permission-gated. Photo stays local — never upload to Jev / /v1/decide.'
  }
}

export function isDesktopAdapterId(raw: unknown): raw is DesktopAdapterId {
  return typeof raw === 'string' && (DESKTOP_ADAPTER_IDS as readonly string[]).includes(raw)
}

/** Fingerprint for idempotency / mid-sentence commit tracking. */
export function desktopActionFingerprint(req: DesktopActionRequest): string {
  if (req.id === 'desktop.create_note') return `${req.id}:${req.args.title}`
  if (req.id === 'desktop.google_search') return `${req.id}:${req.args.q}`
  return req.id
}

/** Hard rule: photo bytes never leave the seat toward decide/Jev. */
export function desktopActionMayReachDecide(id: DesktopAdapterId): boolean {
  return id !== 'desktop.photo_booth_capture'
}
