import type { ApplicationKind } from './application-catalog-view'

/** Main-process-only input. Never use this type as an IPC payload or log it.
 * Platform providers must establish canonical installation identity and fingerprint
 * from native evidence, not a display label or model-provided data.
 */
export type NativeApplicationIdentity =
  { platform: 'darwin'; bundlePath: string; bundleId: string; fingerprint: string } |
  { platform: 'win32'; executablePath: string; fingerprint: string } |
  { platform: 'win32'; aumid: string; fingerprint: string }

export interface DiscoveredApplication {
  displayName: string
  aliases: string[]
  kind: ApplicationKind
  available: boolean
  native: NativeApplicationIdentity
}

/** Discovery is injected, not implemented by the catalog. Unknown forces validation. */
export interface ApplicationDiscovery {
  discover(): Promise<unknown>
}
