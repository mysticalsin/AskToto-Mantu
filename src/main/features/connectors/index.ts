export { bootstrapConnectorAccounts } from './connector-accounts-bootstrap'
export type { ConnectorAccountsBootstrapDeps } from './connector-accounts-bootstrap'
export {
  configureConnectorAccountRuntime,
  ensureCurrentConnectorAccount,
  runConnectorWrite,
  runConnectorWriteDetailed
} from './connector-runtime'
export type { ConnectorAccountRuntime } from './connector-runtime'
// Primitives other features (custom MCP, G63) compose: scoped refs, the atomic scoped store, the catalog and executor.
export { connectorAccountScopeKey, deriveConnectorAccountRef } from './account-ref'
export type { ConnectorAccountScope, ExecutorAccountResolver } from './account-ref'
export { within, writeJsonAtomic } from './account-store'
export { createCatalogPublisher } from './catalog-publisher'
export { createActionGuardWriteGate, createConnectorExecutor, writeArgsHash } from './connector-executor'
export type { ConnectorGrantSeam, ConnectorHandlers } from './connector-executor'
