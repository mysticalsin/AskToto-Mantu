/**
 * Human Dust / managed-cli npm failures. Exit 127 is "command not found"
 * (Electron PATH has no node). Never show a half install as Connected.
 */

export const NPM_MISSING_NODE_ERROR =
  'Métis could not find Node to install Dust. The bundled Node is missing. Reinstall Métis, then try Set up Dust again.'

export const NPM_EXIT_127_ERROR =
  'Dust setup could not run npm (command not found). Métis needs the bundled Node, not a system install. Reinstall Métis or try Set up Dust again.'

const SECRET_BLOB = /(sk-|sk-ant-|dust_|ghp_|xox|Bearer\s+)[a-zA-Z0-9._\-]{8,}/gi

export function humanizeNpmInstallError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/ManagedNpmMissing|bundled Node is missing/i.test(raw)) return NPM_MISSING_NODE_ERROR
  if (/exit 127|ENOENT|not found|spawn .*ENOENT/i.test(raw)) return NPM_EXIT_127_ERROR
  const cleaned = raw.replace(SECRET_BLOB, '[redacted]').trim()
  return cleaned || NPM_MISSING_NODE_ERROR
}

export function npmInstallLooksLikeMissingBinary(code: number | null, spawnError?: unknown): boolean {
  if (code === 127) return true
  const msg = spawnError instanceof Error ? spawnError.message : String(spawnError || '')
  return /ENOENT|not found/i.test(msg)
}
