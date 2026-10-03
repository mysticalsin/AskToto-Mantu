import { SERVER_AUTHORITATIVE_SETTINGS_KEYS } from '@shared/contracts/settings/server-authoritative'

export function stripServerAuthoritativeSettingsPatch<T extends object>(patch: T): T {
  const record = patch as Record<string, unknown>
  for (const key of SERVER_AUTHORITATIVE_SETTINGS_KEYS) {
    if (key in record) delete record[key]
  }
  return patch
}
