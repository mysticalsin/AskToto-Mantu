import type { Settings } from '../../ipc'

export const SERVER_AUTHORITATIVE_SETTINGS_DESCRIPTION = 'server-authoritative-setting'

export const SERVER_AUTHORITATIVE_SETTINGS_KEYS = [
  'licenseKey',
  'licenseCompanyName',
  'licenseSeatCap',
  'licenseExpiresAt',
  'licenseValid',
  'licenseLastValidatedAt',
  'licenseLease',
  'trialStartedAt',
  'mcpConnections',
  'clickupClientId',
  'planeClientId',
  'permissionState',
  'operatorTier',
  'operatorEntitlements',
  'operatorIntegrationsVersion',
  'operatorEntitlementsAt',
  'operatorLicenseToken',
  'operatorLicenseJti',
  'operatorLicenseLast4',
  'operatorLicenseExpiresAt'
] as const satisfies readonly (keyof Settings)[]

export type ServerAuthoritativeSettingsKey = (typeof SERVER_AUTHORITATIVE_SETTINGS_KEYS)[number]
