import { redactSecrets } from '@shared/redact'

/** The recent-conversation tail the screen fast path carries beside the description (characters). */
const TAIL_CHARS = 1500

export interface AmbientScreenRequest {
  mode: string
  wantsScreenContext?: boolean
  transcript?: string
  screenContext?: string
}

export interface AmbientScreenDeps {
  /** The freshest on-device description of the foreground window, or null (the ambient reader's cache). */
  fresh(): { description: string } | null
  redact: boolean
  log(message: string): void
}

/**
 * Screen fast path (M13), moved out of the main ask handler: injects main's OWN cached screen description (already
 * re-validated for freshness by its reader) plus a short recent-conversation tail. Best-effort: a stale cache answers
 * from the prompt alone. On macOS the description can be a verbatim OCR extract of the screen, so it is redacted like the
 * transcript before it can reach a cloud provider. The manifest names this record as ambient, not as something the
 * owner asked for.
 *
 * Returns whether the answer is grounded in a screen description (reported on stream:meta), or undefined when the ask
 * did not use the fast path.
 */
export function applyAmbientScreenContext(req: AmbientScreenRequest, deps: AmbientScreenDeps): boolean | undefined {
  if (req.mode !== 'answer' || !req.wantsScreenContext) return undefined
  try {
    const ctx = deps.fresh()
    if (ctx?.description) {
      const description = deps.redact ? redactSecrets(ctx.description) : ctx.description
      const tail = (req.transcript ?? '').slice(-TAIL_CHARS).trim()
      req.screenContext = tail ? `${description}\n\nRecent conversation (most recent speech):\n${tail}` : description
    }
  } catch (err) {
    deps.log(`[screen-preprocess] context injection failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  return !!req.screenContext
}
