import { app } from 'electron'
import { join } from 'node:path'
import { readManagedSpeechPolicy } from './managed-speech-providers'
import { readSettingsAtAuthorityBoundary } from './store'
import { adminManagedConfigPath, readTrustedAdminManagedBytes } from './win-security'
import { legacyCloudSttAdmission, type LegacyCloudSttAdmission } from './legacy-cloud-stt-policy'

/** Each call re-reads settings and both managed policy files at the authorization boundary. */
export async function readLegacyCloudSttAdmission(): Promise<LegacyCloudSttAdmission> {
  try {
    const [authority, managedPolicy] = await Promise.all([
      readSettingsAtAuthorityBoundary(),
      readManagedSpeechPolicy(
        join(app.getPath('userData'), 'managed-config.json'),
        adminManagedConfigPath(),
        readTrustedAdminManagedBytes
      )
    ])
    return legacyCloudSttAdmission(authority, managedPolicy)
  } catch {
    return { ok: false, error: 'This profile requires the approved speech gateway.', code: 'APPROVED_GATEWAY_REQUIRED' }
  }
}
