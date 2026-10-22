import { z } from 'zod'

/**
 * Screen observation contract (G16, CAP-10): what a capture is OF, and which revocation epoch it belongs to.
 *
 * Every capture used for Ask or screen context carries a ScreenObservationIdentity. `generation` is the
 * revocation epoch: main bumps it whenever access to the screen is withdrawn (Screen Recording revoked,
 * Private View on, sign-out, lock, suspend, end of the session), and a result whose generation is no
 * longer current is dropped. `sequence` orders captures within one app run, so a mark or an answer can name
 * the exact frame it is about.
 */

/** A rectangle on one display, as fractions of the display (0 to 1), so it survives a DPI or scale change. */
export const ScreenRegionSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0.01).max(1),
    height: z.number().min(0.01).max(1)
  })
  .strict()
  .refine((r) => r.x + r.width <= 1.0001 && r.y + r.height <= 1.0001, 'The region must stay inside the display.')
export type ScreenRegion = z.infer<typeof ScreenRegionSchema>

/** What one turn may look at. The default is the whole display under the cursor. */
export const ScreenScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('display') }).strict(),
  z.object({ kind: z.literal('region'), region: ScreenRegionSchema }).strict(),
  z.object({ kind: z.literal('window'), windowId: z.string().min(1).max(128) }).strict()
])
export type ScreenScope = z.infer<typeof ScreenScopeSchema>
export type ScreenScopeKind = ScreenScope['kind']

const trim = (n: number): string => String(Number(n.toFixed(4)))

/** Stable name of the thing that was captured: `display:7`, `display:7/region:x,y,w,h`, `window:<id>`. */
export function screenSourceId(scope: ScreenScope, displayId: number): string {
  if (scope.kind === 'window') return `window:${scope.windowId}`
  if (scope.kind === 'region') {
    const { x, y, width, height } = scope.region
    return `display:${displayId}/region:${[x, y, width, height].map(trim).join(',')}`
  }
  return `display:${displayId}`
}

export const ScreenObservationIdentitySchema = z.object({
  observationId: z.string().min(1).max(64),
  sequence: z.number().int().positive(),
  sourceId: z.string().min(1).max(160),
  scope: z.enum(['display', 'window', 'region']),
  generation: z.number().int().nonnegative(),
  capturedAt: z.number().int().nonnegative()
})
export type ScreenObservationIdentity = z.infer<typeof ScreenObservationIdentitySchema>

export const CaptureResultSchema = z.object({
  /** base64 JPEG, no data: prefix */
  image: z.string(),
  width: z.number(),
  height: z.number(),
  /** Epoch ms when the screenshot was captured or cache-filled; used for real freshness UI. */
  capturedAt: z.number().int().nonnegative(),
  /** True when the captured monitor didn't match the cursor's display (fell back to sources[0]);
   *  the renderer surfaces a soft "captured a different monitor" notice. */
  displayMismatch: z.boolean().optional(),
  /** What this frame is of and the revocation epoch it was taken in (G16). */
  observation: ScreenObservationIdentitySchema.optional()
})
export type CaptureResult = z.infer<typeof CaptureResultSchema>
