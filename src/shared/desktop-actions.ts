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

/** The only browser a request can name. Absent means the system default browser: no silent substitution either way. */
export type DesktopBrowser = 'arc'

export type DesktopActionArgs = {
  'desktop.open_notes': Record<string, never>
  /** `title` is at most 120 characters and `body` at most 2000 (src/shared/voice/catalog.ts validates them). */
  'desktop.create_note': { title: string; body?: string }
  'desktop.open_arc': Record<string, never>
  'desktop.google_search': { q: string; browser?: DesktopBrowser }
  'desktop.open_x': { browser?: DesktopBrowser }
  'desktop.photo_booth_capture': Record<string, never>
}

export type DesktopActionRequest = {
  [K in DesktopAdapterId]: { id: K; args: DesktopActionArgs[K] }
}[DesktopAdapterId]

export type DesktopActionOutcome = 'verified' | 'unknown' | 'failed' | 'cancelled' | 'unsupported'

/**
 * Readback evidence for a verified effect. The adapter echoes the idempotency key and args hash main derived for
 * this dispatch and describes what it observed. A `verified` result without a matching receipt is not trusted.
 */
export interface DesktopActionReceipt {
  idempotencyKey: string
  argsHash: string
  observation: string
}

export interface DesktopActionResult {
  id: DesktopAdapterId
  ok: boolean
  outcome: DesktopActionOutcome
  detail?: string
  /** Required for `verified` (observed-receipt rule). Ignored for every other outcome. */
  receipt?: DesktopActionReceipt
  /** True when the preferred app was missing and we refused a silent substitute. */
  preferredMissing?: boolean
}

/** Windows disclosure — never silent substitute for Mac preferred apps. */
export const WINDOWS_DESKTOP_EQUIVALENTS: Record<DesktopAdapterId, { preferred: string; note: string }> = {
  'desktop.open_notes': {
    preferred: 'Sticky Notes (or Notepad)',
    note: 'Mac Notes has no silent Win twin; fail visibly if Sticky Notes / Notepad unavailable.'
  },
  'desktop.create_note': {
    preferred: 'A .txt file in Documents\\Métis Notes, opened in Notepad',
    note: 'Windows has no Notes twin: the note is a text file named from the title (unsafe characters removed), never overwriting an existing file.'
  },
  'desktop.open_arc': {
    preferred: 'Arc (if installed)',
    note: 'Do NOT silently swap to Edge/Chrome. Disclose missing Arc.'
  },
  'desktop.google_search': {
    preferred: 'Default browser Google search',
    note: 'Open the Google search URL in the default browser. Naming Arc is refused on Windows, never swapped for another browser.'
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
  if (req.id === 'desktop.google_search')
    return `${req.id}:${req.args.q}${req.args.browser ? `@${req.args.browser}` : ''}`
  if (req.id === 'desktop.open_x' && req.args.browser) return `${req.id}@${req.args.browser}`
  return req.id
}

/** Hard rule: photo bytes never leave the seat toward decide/Jev. */
export function desktopActionMayReachDecide(id: DesktopAdapterId): boolean {
  return id !== 'desktop.photo_booth_capture'
}
