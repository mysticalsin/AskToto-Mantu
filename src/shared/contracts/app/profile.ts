import { z } from 'zod'

export const ProfileSchema = z.object({
  name: z.string().default(''),
  role: z.string().default(''),
  company: z.string().default(''),
  resume: z.string().default(''),
  jobDescription: z.string().default(''),
  notes: z.string().default('')
})
export type Profile = z.infer<typeof ProfileSchema>
