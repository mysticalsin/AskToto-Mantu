import { z } from 'zod'

export const UnauthenticatedResultSchema = z.object({
  ok: z.literal(false),
  code: z.literal('UNAUTHENTICATED'),
  error: z.literal('Sign in with your Mantu account first.')
})
export type UnauthenticatedResult = z.infer<typeof UnauthenticatedResultSchema>
export const UNAUTHENTICATED_RESULT: UnauthenticatedResult = {
  ok: false,
  code: 'UNAUTHENTICATED',
  error: 'Sign in with your Mantu account first.'
}
