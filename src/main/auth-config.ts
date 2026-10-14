import type { Settings } from '@shared/ipc'
import { getSettings } from './store'

export interface AzureConfig {
  clientId: string
  tenantId: string
  allowedDomain: string
}

function isSafeConfigValue(value: string): boolean {
  return value.length > 0 && value.length <= 253 && /^[A-Za-z0-9.-]+$/.test(value)
}

const TENANT_GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export function isPlausibleAzureConfig(config: AzureConfig): boolean {
  return isSafeConfigValue(config.clientId) && TENANT_GUID_RE.test(config.tenantId) && isSafeConfigValue(config.allowedDomain)
}

export function usableAzureConfig(config: Partial<AzureConfig>): AzureConfig | null {
  if (!config.clientId || !config.tenantId || !config.allowedDomain) return null
  const result = { clientId: config.clientId, tenantId: config.tenantId, allowedDomain: config.allowedDomain }
  return isPlausibleAzureConfig(result) ? result : null
}

export function azureFromManagedContent(raw: string): Partial<AzureConfig> {
  try {
    const azure = JSON.parse(raw)?.azure
    if (azure?.clientId && azure?.tenantId && azure?.allowedDomain) {
      return { clientId: azure.clientId, tenantId: azure.tenantId, allowedDomain: azure.allowedDomain }
    }
  } catch {
    // An invalid managed document carries no usable Azure block.
  }
  return {}
}

export function readSettingsAzure(settings?: Settings): Partial<AzureConfig> {
  try {
    const value = settings ?? getSettings()
    const clientId = (value.azureClientId || '').trim()
    const tenantId = (value.azureTenantId || '').trim()
    const allowedDomain = (value.azureAllowedDomain || '').trim().replace(/^@/, '')
    if (clientId && tenantId && allowedDomain) return { clientId, tenantId, allowedDomain }
  } catch {
    // Unreadable settings leave SSO unconfigured.
  }
  return {}
}

export function resolveLeaseConfig(
  settings: Settings,
  admin: Record<string, unknown>,
  user: Record<string, unknown>,
  sticky: boolean,
  lkg: Record<string, unknown>
): AzureConfig | null {
  const env = usableAzureConfig({
    clientId: process.env.AZURE_CLIENT_ID,
    tenantId: process.env.AZURE_TENANT_ID,
    allowedDomain: process.env.ASKTOTO_ALLOWED_DOMAIN
  })
  if (env) return env
  const adminAzure = azureFromManagedContent(JSON.stringify(admin))
  const managedAzure = adminAzure.clientId ? adminAzure : azureFromManagedContent(JSON.stringify(user))
  const managed = usableAzureConfig(managedAzure)
  if (managed) return managed
  const selfServe = usableAzureConfig(readSettingsAzure(settings))
  if (selfServe) return selfServe
  if (sticky) {
    return usableAzureConfig({
      clientId: String(lkg.clientId || '').trim(),
      tenantId: String(lkg.tenantId || '').trim(),
      allowedDomain: String(lkg.allowedDomain || '').trim().replace(/^@/, '')
    })
  }
  return null
}

export function leaseEnforced(admin: Record<string, unknown>, user: Record<string, unknown>): boolean {
  return (
    /^(1|true|yes)$/i.test(process.env.ASKTOTO_REQUIRE_AUTH || '') ||
    admin.requireAuth === true ||
    user.requireAuth === true
  )
}
