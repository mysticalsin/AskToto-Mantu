import type { PublicSettings, ServerAuthoritativeSettingsKey } from '@shared/ipc'

type SetSettingsPatch = Parameters<typeof window.toto.setSettings>[0]
type Assert<T extends true> = T

type SetSettingsRejectsAllServerAuthoritativeKeys = Assert<
  Extract<ServerAuthoritativeSettingsKey, keyof SetSettingsPatch> extends never ? true : false
>

type ServerAuthoritativePatchProbe = {
  [Key in ServerAuthoritativeSettingsKey]: { [PatchKey in Key]: PublicSettings[PatchKey] }
}[ServerAuthoritativeSettingsKey]

type ExpectSetSettingsPatch<T extends SetSettingsPatch> = T

// @ts-expect-error Server-authoritative settings are written by main, never renderer settings patches.
type SetSettingsRejectsServerAuthoritativePatch = ExpectSetSettingsPatch<ServerAuthoritativePatchProbe>

export type PreloadSettingsTypecheck =
  | SetSettingsRejectsAllServerAuthoritativeKeys
  | SetSettingsRejectsServerAuthoritativePatch
