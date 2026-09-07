/**
 * Registers every admin route from its feature module. Imported once, for side effects, by
 * `index.ts`. Adding a new admin feature module means adding one import + one call here, never
 * editing `index.ts`'s dispatch chain.
 */
import { registerAdminCoreRoutes } from './admin-core'
import { registerLiveRoutes } from './live'
import { registerEventsRoutes } from './events'
import { registerSessionsRoutes } from './sessions'
import { registerGroupsRoutes } from './groups'
import { registerIntegrationsRoutes } from './integrations'
import { registerConnectorsOAuthRoutes } from './connectors-oauth'
import { registerSettingsRoutes } from './settings-store'
import { registerExportRoutes } from './export'
import { registerSeatTimelineRoutes } from './seat-timeline'
import { registerInsightsRoutes } from './insights'
import { registerMcpGatewayRoutes } from './mcp-gateway'

registerAdminCoreRoutes()
registerLiveRoutes()
registerEventsRoutes()
registerSessionsRoutes()
registerGroupsRoutes()
registerIntegrationsRoutes()
registerConnectorsOAuthRoutes()
registerSettingsRoutes()
registerExportRoutes()
registerSeatTimelineRoutes()
registerInsightsRoutes()
registerMcpGatewayRoutes()
