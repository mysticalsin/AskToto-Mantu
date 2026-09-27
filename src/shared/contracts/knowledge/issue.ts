import { z } from 'zod'

/** Reports a violated contract invariant at `path`, relative to the value being refined. */
export function reportIssue(context: z.RefinementCtx, message: string, path: Array<string | number>): void {
  context.addIssue({ code: z.ZodIssueCode.custom, message, path })
}
