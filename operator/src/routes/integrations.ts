/**
 * Placeholder for Integrations admin routes (plan section 9c "Settings -> Integrations": CRUD for
 * CRM/MCP connections, vault-encrypted credential, scope by tier/group, server-side "test
 * connection" probe, rotate/revoke). The `integrations` and `integration_grants` tables and the
 * store methods (`listIntegrationsMeta`, `putIntegration`, `listIntegrationGrants`,
 * `bumpIntegrationUse`, ...) already exist; this module registers nothing yet so `routes/index.ts`
 * has one stable import list and a future pass can fill it in with `defineRoute` calls, without
 * touching `index.ts` or `routes/index.ts`.
 *
 * This is the admin (console-side) counterpart of `./integrations-seat.ts`, which already
 * implements the seat-facing `GET /v1/integrations` delivery route.
 */
export function registerIntegrationsRoutes(): void {
  // Intentionally empty.
}
