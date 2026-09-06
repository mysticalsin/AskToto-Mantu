/**
 * Placeholder for Groups admin routes (plan section 9c "Groups": `GET/POST /v1/admin/groups`,
 * `GET/PATCH/DELETE /v1/admin/groups/:id`, members, per-group license generation, `GET/PATCH
 * /v1/admin/tiers`). The `groups`, `group_members` and `tiers` tables and the store methods
 * (`listGroups`, `putGroup`, `listGroupMembers`, `putGroupMember`, `listTiers`, `putTier`, ...)
 * already exist; this module registers nothing yet so `routes/index.ts` has one stable import list
 * and a future pass can fill it in with `defineRoute` calls, without touching `index.ts` or
 * `routes/index.ts`.
 */
export function registerGroupsRoutes(): void {
  // Intentionally empty.
}
