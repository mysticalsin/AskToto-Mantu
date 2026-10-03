import { z } from 'zod'

export const EntityKindSchema = z.enum(['person', 'account', 'deal'])
export type EntityKind = z.infer<typeof EntityKindSchema>
