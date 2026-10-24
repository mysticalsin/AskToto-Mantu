import { currentUserMemory } from '../user-memory'
import { connectorCatalog, connectorExecutor, connectorReadReady, ensureCurrentConnectorAccount } from '../connectors'
import { createReadOnlyConnectorPort } from './read-only-port'
import { calendarSource, memorySource, type ResearchSource } from './sources'

/**
 * The sources the app's suggestion pipeline reads, composed once: today's calendar through the read-only connector
 * port (it never sees the executor's write path) and the owner's remembered preferences (G57). Both are already granted
 * by the owner. Server memory (G59) and document grants (G46) are added here when their sources exist.
 */
export function defaultResearchSources(): ResearchSource[] {
  const port = createReadOnlyConnectorPort(connectorExecutor(), connectorCatalog)
  return [
    calendarSource({
      port,
      accounts: { current: ensureCurrentConnectorAccount, ready: connectorReadReady },
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    }),
    memorySource({ memory: currentUserMemory, now: Date.now })
  ]
}
