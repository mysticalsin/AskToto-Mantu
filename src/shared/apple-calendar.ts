import { z } from 'zod'

/**
 * Apple Calendar "Add to calendar" (G65c). The renderer asks main for the OS permission state, may ask main to raise
 * the system prompt (only from an explicit click), and sends a subject and a time range. It never sees an event id,
 * an account ref or the helper's output. The write itself always goes through the connector confirm card.
 */
export const APPLE_CALENDAR_IPC = Object.freeze({
  status: 'apple-calendar:status',
  ask: 'apple-calendar:ask',
  create: 'apple-calendar:create'
})

export const APPLE_CALENDAR_PERMISSIONS = ['notDetermined', 'denied', 'restricted', 'writeOnly', 'fullAccess'] as const
export const AppleCalendarPermissionSchema = z.enum(APPLE_CALENDAR_PERMISSIONS)
export type AppleCalendarPermission = z.infer<typeof AppleCalendarPermissionSchema>

/** `available` is false off macOS, without the helper, or when signed out. `permission` never comes from a prompt. */
export const AppleCalendarStatusSchema = z
  .object({ available: z.boolean(), permission: AppleCalendarPermissionSchema.optional() })
  .strict()
export type AppleCalendarStatus = z.infer<typeof AppleCalendarStatusSchema>

export const AppleCalendarCreateRequestSchema = z
  .object({ subject: z.string().max(200), startIso: z.string().max(40), endIso: z.string().max(40) })
  .strict()
export type AppleCalendarCreateRequest = z.infer<typeof AppleCalendarCreateRequestSchema>

export const AppleCalendarCreateResultSchema = z
  .object({
    ok: z.boolean(),
    error: z.string().max(300).optional(),
    /** The save may have happened but could not be confirmed. Never retried. */
    uncertain: z.boolean().optional(),
    /** The typed `os_permission_missing` refusal, with the permission state behind it. */
    permission: AppleCalendarPermissionSchema.optional()
  })
  .strict()
export type AppleCalendarCreateResult = z.infer<typeof AppleCalendarCreateResultSchema>

/** What the owner reads when the OS has not given Métis calendar access. */
export function appleCalendarPermissionCopy(permission: AppleCalendarPermission): string {
  switch (permission) {
    case 'notDetermined':
      return 'Métis has not asked for Calendar access yet. Choose Allow Calendar access.'
    case 'writeOnly':
      return 'Calendar access is write-only, so Métis cannot check the event was saved. Allow full access in System Settings → Privacy & Security → Calendars.'
    case 'denied':
    case 'restricted':
      return 'Calendar access is off for Métis. Turn it on in System Settings → Privacy & Security → Calendars.'
    case 'fullAccess':
      return 'Calendar access is on.'
  }
}
