/** Read back the existing sensitive-route gateway before protected traffic.
 * Never provision or silently repair a shared account's gateway from a vault save
 * or an inference request. A configuration check is NOT an end-to-end retention
 * certification: the independent sink/speech/provider tests remain release gates.
 */
export const DEFAULT_AI_GATEWAY_ID = 'default'
const ENSURE_TIMEOUT_MS = 8_000
const MAX_CONFIG_RESPONSE_BYTES = 65_536
const API_ORIGIN = 'https://api.cloudflare.com'

export type GatewayPrivacyErrorCode =
  | 'GATEWAY_CREDENTIALS_REQUIRED'
  | 'GATEWAY_CHECK_OPTIONS_INVALID'
  | 'GATEWAY_CHECK_CANCELLED'
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

export async function ensureDefaultAiGateway(
  token: string,
  accountId: string,
  fetchImpl: typeof fetch,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<void> {
  const id = accountId.trim()
  const secret = token.trim()
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !secret || /[\r\n]/.test(secret)) {
    throw new GatewayPrivacyError('GATEWAY_CREDENTIALS_REQUIRED')
  }
  const timeoutMs = options.timeoutMs ?? ENSURE_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > ENSURE_TIMEOUT_MS) {
    throw new GatewayPrivacyError('GATEWAY_CHECK_OPTIONS_INVALID')
  }
  if (options.signal?.aborted) throw new GatewayPrivacyError('GATEWAY_CHECK_CANCELLED')

  const url = `${API_ORIGIN}/client/v4/accounts/${encodeURIComponent(id)}/ai-gateway/gateways/${DEFAULT_AI_GATEWAY_ID}`
  const controller = new AbortController()
  let timedOut = false
  const abortError = (): GatewayPrivacyError => new GatewayPrivacyError(
    timedOut ? 'GATEWAY_CHECK_TIMEOUT' : 'GATEWAY_CHECK_CANCELLED'
  )
  let rejectAborted!: (error: GatewayPrivacyError) => void
  const aborted = new Promise<never>((_, reject) => { rejectAborted = reject })
  const onControllerAbort = (): void => rejectAborted(abortError())
  const onCallerAbort = (): void => controller.abort()
  controller.signal.addEventListener('abort', onControllerAbort, { once: true })
  options.signal?.addEventListener('abort', onCallerAbort, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let fullyRead = false
  try {
    const pending = Promise.resolve().then(() => fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${secret}`, accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal
    }))
    // A test double or an intermediary can ignore abort. Dispose its late body as
    // well as bounding the caller; never launch a fallback request or a retry.
    void pending.then(response => {
      if (controller.signal.aborted) cancelResponse(response)
    }, () => undefined)
    const response = await Promise.race([pending, aborted])
    if (controller.signal.aborted) throw abortError()
    if (response.redirected || (response.url && response.url !== url)) {
      cancelResponse(response)
      throw new GatewayPrivacyError('GATEWAY_RESPONSE_UNVERIFIED')
    }
    if (!response.ok) {
      cancelResponse(response)
      throw new GatewayPrivacyError(
        response.status === 404 ? 'GATEWAY_REVIEW_REQUIRED' :
        response.status === 401 || response.status === 403 ? 'GATEWAY_CHECK_DENIED' :
        'GATEWAY_CHECK_UNAVAILABLE'
      )
    }
    if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '') ||
        Number(response.headers.get('content-length')) > MAX_CONFIG_RESPONSE_BYTES) {
      cancelResponse(response)
      throw new GatewayPrivacyError('GATEWAY_RESPONSE_UNVERIFIED')
    }
    reader = response.body?.getReader()
    if (!reader) throw new GatewayPrivacyError('GATEWAY_RESPONSE_UNVERIFIED')
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const next = await Promise.race([reader.read(), aborted])
      if (next.done) { fullyRead = true; break }
      size += next.value.byteLength
      if (size > MAX_CONFIG_RESPONSE_BYTES) throw new GatewayPrivacyError('GATEWAY_RESPONSE_UNVERIFIED')
      chunks.push(next.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    let data: unknown
    try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { throw new GatewayPrivacyError('GATEWAY_RESPONSE_UNVERIFIED') }
    assertSensitiveRouteConfiguration(data)
  } catch (error) {
    if (error instanceof GatewayPrivacyError) throw error
    if (controller.signal.aborted) throw abortError()
    throw new GatewayPrivacyError('GATEWAY_CHECK_UNAVAILABLE')
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onCallerAbort)
    controller.signal.removeEventListener('abort', onControllerAbort)
    if (reader) {
      if (!fullyRead) void reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
}

export function isCloudflareVaultPaste(provider: string, accountId: string | undefined): boolean {
  return provider === 'cloudflare' && Boolean(accountId?.trim())
}
