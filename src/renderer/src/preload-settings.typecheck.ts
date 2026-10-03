import type { ServerAuthoritativeSettingsKey } from '@shared/ipc'

type SetSettingsPatch = Parameters<typeof window.toto.setSettings>[0]
type Assert<T extends true> = T

const setSettingsRejectsAllServerAuthoritativeKeys: Assert<
  Extract<ServerAuthoritativeSettingsKey, keyof SetSettingsPatch> extends never ? true : false
> = true
void setSettingsRejectsAllServerAuthoritativeKeys

// @ts-expect-error Server-authoritative settings are written by main, never renderer settings patches.
void window.toto.setSettings({ licenseValid: true })
