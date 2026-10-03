import { z } from 'zod'

export const CaptureResultSchema = z.object({
  /** base64 JPEG, no data: prefix */
  image: z.string(),
  width: z.number(),
  height: z.number(),
  /** Epoch ms when the screenshot was captured or cache-filled; used for real freshness UI. */
  capturedAt: z.number().int().nonnegative(),
  /** True when the captured monitor didn't match the cursor's display (fell back to sources[0]);
   *  the renderer surfaces a soft "captured a different monitor" notice. */
  displayMismatch: z.boolean().optional()
})
export type CaptureResult = z.infer<typeof CaptureResultSchema>

/** Result of the screen:context IPC — a pre-analyzed, on-device description of the current screen, or null
 *  when none is fresh (window changed / too old / feature off). The renderer uses a non-null result to take
 *  the no-capture fast-path; the description text itself is only ever re-derived by main at ask time. */
export const ScreenContextResultSchema = z
  .object({
    description: z.string(),
    capturedAt: z.number().int().nonnegative()
  })
  .nullable()
export type ScreenContextResult = z.infer<typeof ScreenContextResultSchema>
