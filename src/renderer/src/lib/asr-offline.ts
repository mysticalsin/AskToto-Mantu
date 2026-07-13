/**
 * Resolve the Whisper model source without letting an uncertain runtime state enable a download.
 * Production always uses installer-owned assets. Development may use the remote resolver only when
 * the main process explicitly reports that bundled assets are absent (`false`). A missing/failed probe
 * is therefore treated as bundled so the caller fails locally instead of reaching the network.
 */
export function shouldUseBundledAsr(
  production: boolean,
  bundledProbe: boolean | null | undefined
): boolean {
  return production || bundledProbe !== false
}
