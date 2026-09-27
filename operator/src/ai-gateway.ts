/** Read back the existing sensitive-route gateway before protected traffic.
 * Never provision or silently repair a shared account's gateway from a vault save
 * or an inference request. A configuration check is NOT an end-to-end retention
 * certification: the independent sink/speech/provider tests remain release gates.
 */
export const DEFAULT_AI_GATEWAY_ID = 'default'
const VERIFY_TIMEOUT_MS = 8_000
const MAX_CONFIG_RESPONSE_BYTES = 65_536
const API_ORIGIN = 'https://api.cloudflare.com'

export type GatewayPrivacyErrorCode =
  | 'GATEWAY_CREDENTIALS_REQUIRED'
  | 'GATEWAY_CHECK_OPTIONS_INVALID'
  | 'GATEWAY_CHECK_TIMEOUT'
  | 'GATEWAY_REVIEW_REQUIRED'
  | 'GATEWAY_CHECK_DENIED'
  | 'GATEWAY_CHECK_UNAVAILABLE'
  | 'GATEWAY_RESPONSE_UNVERIFIED'
  | 'GATEWAY_CONFIGURATION_UNSAFE'

/** Only content-free, stable errors leave this boundary. Never attach an upstream
 * response, token, account identifier, response URL, or original exception cause.
 */
export class GatewayPrivacyError extends Error {
  constructor(readonly code: GatewayPrivacyErrorCode) {
    super(code)
    this.name = 'GatewayPrivacyError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cancelResponse(response: Response): void {
  // Do not wait for a peer's cancellation acknowledgement.
  if (response.body) void response.body.cancel().catch(() => undefined)
}

/** Cloudflare's own failure codes collapse to the two an operator can act on: the
 * gateway needs a human look (missing/forbidden), or the check itself is unavailable.
 */
function statusErrorCode(status: number): GatewayPrivacyErrorCode {
  if (status === 404) return 'GATEWAY_REVIEW_REQUIRED'
  if (status === 401 || status === 403) return 'GATEWAY_CHECK_DENIED'
  return 'GATEWAY_CHECK_UNAVAILABLE'
}

/** Named minimum configuration for the existing `default` sensitive route.
 * Metadata-only usage continues through the Operator's ask-meter; no source text
 * belongs in this management response, a log export, or a response cache.
 */
function assertSensitiveRouteConfiguration(data: unknown): void {
  if (!isRecord(data) || data.success !== true || !isRecord(data.result)) {
    throw new GatewayPrivacyError('GATEWAY_RESPONSE_UNVERIFIED')
  }
  const result = data.result
  if (result.id !== DEFAULT_AI_GATEWAY_ID) {
    throw new GatewayPrivacyError('GATEWAY_RESPONSE_UNVERIFIED')
  }
  if (
    result.collect_logs !== false ||
    result.cache_ttl !== 0 ||
    result.logpush !== false ||
    (result.otel !== undefined && (!Array.isArray(result.otel) || result.otel.length !== 0)) ||
    (result.log_classification !== undefined && result.log_classification !== false)
  ) {
    throw new GatewayPrivacyError('GATEWAY_CONFIGURATION_UNSAFE')
  }
}

/** Reads at most MAX_CONFIG_RESPONSE_BYTES of `response`'s body and parses it as JSON.
 * Never buffers past the cap, even when the server omits or understates content-length.
 * `race` bounds each individual read the same way the caller bounded the fetch itself.
 */
async function readBoundedJsonBody(
  response: Response,
  race: <T>(pending: Promise<T>) => Promise<T>
): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new GatewayPrivacyError('GATEWAY_RESPONSE_UNVERIFIED')
  const chunks: Uint8Array[] = []
  let size = 0
  let fullyRead = false
  try {
    for (;;) {
      const next = await race(reader.read())
      if (next.done) {
        fullyRead = true
        break
      }
      size += next.value.byteLength
      if (size > MAX_CONFIG_RESPONSE_BYTES) throw new GatewayPrivacyError('GATEWAY_RESPONSE_UNVERIFIED')
      chunks.push(next.value)
    }
  } finally {
    if (!fullyRead) void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new GatewayPrivacyError('GATEWAY_RESPONSE_UNVERIFIED')
  }
}

export async function verifyDefaultGatewayPrivacy(
  token: string,
  accountId: string,
  fetchImpl: typeof fetch,
  options: { timeoutMs?: number } = {}
): Promise<void> {
  const id = accountId.trim()
  const secret = token.trim()
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !secret || /[\r\n]/.test(secret)) {
    throw new GatewayPrivacyError('GATEWAY_CREDENTIALS_REQUIRED')
  }
  const timeoutMs = options.timeoutMs ?? VERIFY_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > VERIFY_TIMEOUT_MS) {
    throw new GatewayPrivacyError('GATEWAY_CHECK_OPTIONS_INVALID')
  }

  const url = `${API_ORIGIN}/client/v4/accounts/${encodeURIComponent(id)}/ai-gateway/gateways/${DEFAULT_AI_GATEWAY_ID}`
  const controller = new AbortController()
  let rejectTimedOut!: (error: GatewayPrivacyError) => void
  const timedOut = new Promise<never>((_, reject) => {
    rejectTimedOut = reject
  })
  controller.signal.addEventListener(
    'abort',
    () => rejectTimedOut(new GatewayPrivacyError('GATEWAY_CHECK_TIMEOUT')),
    { once: true }
  )
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const race = <T>(pending: Promise<T>): Promise<T> => Promise.race([pending, timedOut])

  try {
    // The Workers runtime accepts only 'follow' or 'manual' for `redirect`; 'error' is a TypeError
    // at fetch time, not a rejected promise. A 3xx is still never trusted or followed: 'manual'
    // returns it as an ordinary response, which the explicit status check below refuses outright.
    const pending = Promise.resolve().then(() =>
      fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${secret}`, accept: 'application/json' },
        redirect: 'manual',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal
      })
    )
    // A test double or an intermediary can ignore abort. Dispose its late body as
    // well as bounding the caller; never launch a fallback request or a retry.
    void pending.then(
      (response) => {
        if (controller.signal.aborted) cancelResponse(response)
      },
      () => undefined
    )
    const response = await race(pending)
    if (response.redirected || (response.url && response.url !== url)) {
      cancelResponse(response)
      throw new GatewayPrivacyError('GATEWAY_RESPONSE_UNVERIFIED')
    }
    if (response.status >= 300 && response.status < 400) {
      cancelResponse(response)
      throw new GatewayPrivacyError('GATEWAY_RESPONSE_UNVERIFIED')
    }
    if (!response.ok) {
      cancelResponse(response)
      throw new GatewayPrivacyError(statusErrorCode(response.status))
    }
    if (
      !/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '') ||
      Number(response.headers.get('content-length')) > MAX_CONFIG_RESPONSE_BYTES
    ) {
      cancelResponse(response)
      throw new GatewayPrivacyError('GATEWAY_RESPONSE_UNVERIFIED')
    }
    const data = await readBoundedJsonBody(response, race)
    assertSensitiveRouteConfiguration(data)
  } catch (error) {
    if (error instanceof GatewayPrivacyError) throw error
    if (controller.signal.aborted) throw new GatewayPrivacyError('GATEWAY_CHECK_TIMEOUT')
    throw new GatewayPrivacyError('GATEWAY_CHECK_UNAVAILABLE')
  } finally {
    clearTimeout(timer)
  }
}

export function isCloudflareVaultPaste(provider: string, accountId: string | undefined): boolean {
  return provider === 'cloudflare' && Boolean(accountId?.trim())
}
