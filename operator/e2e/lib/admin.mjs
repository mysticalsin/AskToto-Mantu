/**
 * Small admin-API client shared by every scenario: plain `fetch()` against the booted Worker with
 * the minted console session cookie (`../boot.mjs`), the same cookie a real signed-in browser tab
 * would carry. No shortcuts through the store — every call is a real HTTP round trip.
 */
import './http.mjs'

export function adminClient(ctx) {
  async function raw(path, { method = 'GET', body, headers = {}, cookie = ctx.cookieHeader, redirect = 'follow' } = {}) {
    const res = await fetch(`${ctx.baseUrl}${path}`, {
      method,
      redirect,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    return res
  }

  async function json(path, opts) {
    const res = await raw(path, opts)
    const text = await res.text()
    let parsed = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    return { status: res.status, json: parsed, text, headers: res.headers }
  }

  async function get(path, opts) {
    return json(path, { ...opts, method: 'GET' })
  }
  async function post(path, body, opts) {
    return json(path, { ...opts, method: 'POST', body })
  }

  /** Raw bytes (for `.xlsx` exports, which are ZIP/binary). */
  async function bytes(path, opts) {
    const res = await raw(path, opts)
    const buf = Buffer.from(await res.arrayBuffer())
    return { status: res.status, buf, headers: res.headers }
  }

  return { raw, json, get, post, bytes }
}
