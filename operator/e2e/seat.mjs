/**
 * A simulated Métis desktop seat: signs `/v1/*` requests exactly the way the real Electron client
 * does (`src/main/operator-hmac-sign.ts`, built on the shared `src/shared/operator-hmac.ts`
 * canonical string — see `./lib/hmac.mjs`), against a real running `metis-operator` Worker.
 *
 * Geo (`request.cf`) cannot be set by request headers a Worker ever reads (`operator/src/geo.ts`
 * reads `request.cf` only — client-supplied country/city/lat/lon are explicitly ignored, see
 * `CLIENT_GEO_KEYS`). Local `wrangler dev` (workerd/Miniflare) instead lets a caller supply
 * `request.cf` itself via the `MF-CF-Blob` request header (JSON-encoded), which is workerd's own
 * local-dev mechanism for simulating different edge locations — not a product backdoor, and not
 * read by the Worker at all once deployed for real (Cloudflare's edge sets `request.cf` itself in
 * production). That is how three seats in three different countries are possible against one local
 * dev D1 in one process.
 */

export class Seat {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl
   * @param {string} opts.secret OPERATOR_INGEST_SECRET
   * @param {string} opts.deviceId 8-128 chars, [A-Za-z0-9._-] (operator/src/hmac.ts DEVICE_ID_RE)
   * @param {string} opts.seatHash
   * @param {'darwin'|'win32'} opts.os
   * @param {string} opts.appVersion
   * @param {string} [opts.hostname]
   * @param {string} [opts.ssoEmail]
   * @param {{country:string,city:string,region?:string,latitude?:string,longitude?:string}} [opts.cf]
   * @param {Awaited<ReturnType<typeof import('./lib/hmac.mjs').loadHmac>>} opts.hmac
   */
  constructor(opts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.secret = opts.secret
    this.deviceId = opts.deviceId
    this.seatHash = opts.seatHash
    this.os = opts.os
    this.appVersion = opts.appVersion
    this.hostname = opts.hostname
    this.ssoEmail = opts.ssoEmail
    this.cf = opts.cf ?? null
    this.hmac = opts.hmac
    this.licenseId = null
    /** Last raw signed headers this seat sent, for a replay test. */
    this.lastHeaders = null
  }

  /** Low-level signed request. `sign` overrides let a caller build a deliberately invalid request
   *  (bad signature, stale timestamp, reused nonce) for the auth/privacy scenario. */
  async request(path, method, bodyObj, { sign = {} } = {}) {
    const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj)
    const headers = this.hmac.headersFor(this.secret, this.deviceId, body, sign)
    this.lastHeaders = headers
    const fetchHeaders = { ...headers }
    if (body) fetchHeaders['content-type'] = 'application/json'
    if (this.cf) fetchHeaders['MF-CF-Blob'] = JSON.stringify(this.cf)
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: fetchHeaders,
      body: body || undefined
    })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: res.status, json, text, headers: res.headers }
  }

  seatMeta(extra = {}) {
    return {
      seatHash: this.seatHash,
      os: this.os,
      appVersion: this.appVersion,
      ...(this.hostname ? { hostname: this.hostname } : {}),
      ...(this.ssoEmail ? { ssoEmail: this.ssoEmail } : {}),
      ...(this.licenseId ? { licenseId: this.licenseId } : {}),
      ...extra
    }
  }

  async heartbeat(extra = {}) {
    return this.request('/v1/heartbeat', 'POST', this.seatMeta(extra))
  }

  async ask({ id, question, questionType, mode, provider, model, ttftMs, totalMs, inputTokens, outputTokens, outcome, ...rest }) {
    return this.request('/v1/ingest', 'POST', {
      id,
      ts: Date.now(),
      mode,
      provider,
      model,
      ttftMs,
      totalMs,
      inputTokens,
      outputTokens,
      outcome: outcome ?? 'answered',
      questionType,
      ...(question ? { question } : {}),
      ...this.seatMeta(),
      ...rest
    })
  }

  async recap({ id, minutes }) {
    return this.request('/v1/ingest', 'POST', { event: 'recap', id, ts: Date.now(), minutes, ...this.seatMeta() })
  }

  async listen({ id, minutes }) {
    return this.request('/v1/ingest', 'POST', { event: 'listen', id, ts: Date.now(), minutes, ...this.seatMeta() })
  }

  async rating({ id, rating }) {
    return this.request('/v1/ingest', 'POST', { event: 'rating', id, rating, ...this.seatMeta() })
  }

  async crmSend({ id, status, title, connector, error, remoteId, remoteUrl, action, attempt, latencyMs, meetingHash }) {
    return this.request('/v1/ingest', 'POST', {
      event: 'crm',
      id,
      ts: Date.now(),
      status,
      title,
      connector,
      ...(error ? { error } : {}),
      ...(remoteId ? { remoteId } : {}),
      ...(remoteUrl ? { remoteUrl } : {}),
      ...(action ? { action } : {}),
      ...(typeof attempt === 'number' ? { attempt } : {}),
      ...(typeof latencyMs === 'number' ? { latencyMs } : {}),
      ...(meetingHash ? { meetingHash } : {}),
      ...this.seatMeta()
    })
  }

  async manifest() {
    return this.request('/v1/skills/manifest', 'GET', undefined)
  }

  async integrations() {
    return this.request('/v1/integrations', 'GET', undefined)
  }
}
