// Staging check `gateway-privacy` (M2-0104): reads back the staging account's `default` AI Gateway with the
// read-only gateway and logs token through verifyDefaultGatewayPrivacy (operator/src/ai-gateway.ts), the same
// function the Worker runs, so the privacy rules live only there. The report carries the readiness state, the
// stable error code, and the values of the three privacy settings the readback returned; never the token, the
// account id, or any other part of the response.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const GATEWAY_SOURCE = 'operator/src/ai-gateway.ts'
export const GATEWAY_TOKEN = 'OPERATOR_STAGING_GATEWAY_READ_TOKEN'
export const PRIVACY_SETTINGS = Object.freeze(['collect_logs', 'cache_ttl', 'logpush'])
const ACCOUNTS_URL = 'https://api.cloudflare.com/client/v4/accounts?per_page=2'
// Error codes verifyDefaultGatewayPrivacy raises after it has parsed a complete, bounded JSON body.
const PARSED_BODY = new Set([null, 'GATEWAY_CONFIGURATION_UNSAFE'])
const SETTINGS_READ_TIMEOUT_MS = 8_000

/** Bundles operator/src/ai-gateway.ts (Worker TypeScript) for Node, as seed-local.mjs does for its fixture. */
export async function loadGatewayModule() {
  const { build } = await import('esbuild')
  const result = await build({
    entryPoints: [join(REPO_ROOT, GATEWAY_SOURCE)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    write: false,
    logLevel: 'silent'
  })
  const file = join(mkdtempSync(join(tmpdir(), 'staging-checks-')), 'ai-gateway.mjs')
  writeFileSync(file, result.outputFiles[0].text)
  return import(pathToFileURL(file).href)
}

/** The one account the token can see, or null: a token that sees none or several does not name the staging account. */
export async function resolveAccountId(token, fetchImpl) {
  try {
    const response = await fetchImpl(ACCOUNTS_URL, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(SETTINGS_READ_TIMEOUT_MS)
    })
    if (!response.ok) return null
    const body = await response.json()
    const accounts = Array.isArray(body?.result) ? body.result : []
    return accounts.length === 1 && typeof accounts[0]?.id === 'string' ? accounts[0].id : null
  } catch {
    return null
  }
}

/** Only booleans and numbers are reported; anything else in the readback is recorded as null. */
async function observedSettings(response) {
  const settings = Object.fromEntries(PRIVACY_SETTINGS.map((key) => [key, null]))
  if (!response) return settings
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), SETTINGS_READ_TIMEOUT_MS).unref())
  const body = await Promise.race([response.json().catch(() => null), timeout])
  for (const key of PRIVACY_SETTINGS) {
    const value = body?.result?.[key]
    if (typeof value === 'boolean' || typeof value === 'number') settings[key] = value
  }
  return settings
}

export async function gatewayPrivacyCheck({ secrets, fetchImpl = fetch, gateway }) {
  const { verifyDefaultGatewayPrivacy, readinessForError } = gateway ?? (await loadGatewayModule())
  const token = String(secrets?.[GATEWAY_TOKEN] ?? '').trim()
  const accountId = token ? await resolveAccountId(token, fetchImpl) : ''
  if (token && !accountId) {
    const settings = await observedSettings(null)
    return { ok: false, report: { gateway: 'default', readiness: 'BLOCKED', error_code: 'GATEWAY_ACCOUNT_UNRESOLVED', settings } }
  }

  let readback = null
  const recordingFetch = async (input, init) => {
    const response = await fetchImpl(input, init)
    readback = response.clone()
    return response
  }
  let readiness
  let errorCode = null
  try {
    readiness = await verifyDefaultGatewayPrivacy(token, accountId, recordingFetch)
  } catch (error) {
    readiness = readinessForError(error)
    errorCode = typeof error?.code === 'string' ? error.code : 'GATEWAY_CHECK_UNAVAILABLE'
  }
  const parsed = PARSED_BODY.has(errorCode)
  if (!parsed) void readback?.body?.cancel().catch(() => undefined)
  const settings = await observedSettings(parsed ? readback : null)
  return { ok: readiness === 'CONFIGURED', report: { gateway: 'default', readiness, error_code: errorCode, settings } }
}
