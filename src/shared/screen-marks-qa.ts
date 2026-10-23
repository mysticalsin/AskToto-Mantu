import { z } from 'zod'
import { ScreenMarkShapeSchema } from './screen-marks'

/**
 * QA-only mark placement (G43). Nothing here may reach a shipping bundle: the channel names and the env name are
 * the packaged-bytes markers scripts/lib/qa-fault-hook.mjs looks for, so only code reached under QA_IDENTITY_BUILD
 * may import this module for its values.
 */
export const QA_SCREEN_MARKS_ENV = 'METIS_QA_SCREEN_MARKS'
export const QA_SCREEN_MARKS_IPC = { place: 'screenMarks:qaPlace', clear: 'screenMarks:qaClear' } as const

export const QaPlaceMarkInputSchema = z
  .object({ screenshotId: z.string().min(1).max(64), shape: ScreenMarkShapeSchema })
  .strict()
export type QaPlaceMarkInput = z.infer<typeof QaPlaceMarkInputSchema>
