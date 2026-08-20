#!/usr/bin/env node
/**
 * Mock OpenAI-compatible endpoint for the physical exhaustion simulation (scripts/qa/exhaustion-sim.mjs).
 * It returns, on demand, the exact failure shapes real providers emit when you run out — a 429 rate-limit,
 * a spent credit balance, a subscription usage-cap — plus a healthy SSE completion carrying low/high
 * rate-limit headers so budget pre-emption can be exercised end to end.
 *
 * The scenario is selected by the URL PATH prefix (the app's `custom` provider baseURL is set per scenario),
 * so one server serves them all: POST /<scenario>/v1/chat/completions.
 *
 *   rate-limit   → 429 + Retry-After: 2, body "Rate limit reached … try again in 2s"
 *   quota        → 400, body "Your credit balance is too low to access the API"
 *   usage-cap    → 429, body "Claude AI usage limit reached|<epoch>"  (a claude-cli-shaped cap)
 *   low-headroom → 200 SSE completion + x-ratelimit-remaining-tokens: 10 / limit 100000 (0.01% left)
 *   ok           → 200 SSE completion + healthy headers
 *
 * Gateway/proxy shapes — a Cloudflare Worker sits between Métis and the model, so it fails in ways a
 * direct provider cannot. Driven by the `cloudflare` group in e2e-workflows.mjs:
 *   auth-bad       → 401 "Invalid METIS_PROXY_KEY"   (the USER's credential — only they can fix it)
 *   gateway-cred   → 502                             (the OPERATOR's Cloudflare token; NOT the user's key)
 *   forbidden      → 403
 *   upstream-error → 500
 *   badbody        → 200 with JSON instead of SSE    (proxy answers without streaming)
 *   midstream      → SSE that dies mid-answer, no [DONE]
 *   hang           → accepts and never answers       (exercises the CLIENT-side timeout)
 *
 * Usage: node scripts/qa/mock-llm-server.mjs [port]   (default 8788). Prints "listening <port>".
 */
import http from 'node:http'
import https from 'node:https'
import { readFileSync } from 'node:fs'

const PORT = Number(process.argv[2] || 8788)
// The app's `custom` provider requires an https:// endpoint (ipc.ts customBaseUrl refine), so serve TLS
// when a throwaway cert is supplied via env (MOCK_TLS_CERT / MOCK_TLS_KEY point at temp PEM files — never
// committed). Launch the app under test with NODE_TLS_REJECT_UNAUTHORIZED=0 so undici accepts the self-
// signed cert. Falls back to plain http when no cert is given.
const TLS =
  process.env.MOCK_TLS_CERT && process.env.MOCK_TLS_KEY
    ? { cert: readFileSync(process.env.MOCK_TLS_CERT), key: readFileSync(process.env.MOCK_TLS_KEY) }
    : null

function sse(res, headers) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...headers
  })
  const chunks = [
    { choices: [{ delta: { role: 'assistant' } }] },
    { choices: [{ delta: { content: 'Backup ' } }] },
    { choices: [{ delta: { content: 'answer ' } }] },
    { choices: [{ delta: { content: 'from mock.' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 3 } }
  ]
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function errorJson(res, status, message, headers = {}) {
  const body = JSON.stringify({ error: { message, type: 'mock_error' } })
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(body)
}

const handler = (req, res) => {
  const url = req.url || ''
  // Drain the request body (the app POSTs a chat payload) before responding.
  req.on('data', () => {})
  req.on('end', () => {
    if (url.includes('/rate-limit/')) {
      return errorJson(res, 429, 'Rate limit reached for requests. Please try again in 2s.', { 'retry-after': '2' })
    }
    if (url.includes('/quota/')) {
      return errorJson(res, 400, 'Your credit balance is too low to access the API. Please add credits to continue.')
    }
    if (url.includes('/usage-cap/')) {
      const resetEpoch = Math.floor(Date.now() / 1000) + 3 * 60 * 60 // 3h out
      return errorJson(res, 429, `Claude AI usage limit reached|${resetEpoch}`)
    }
    if (url.includes('/low-headroom/')) {
      return sse(res, { 'x-ratelimit-remaining-tokens': '10', 'x-ratelimit-limit-tokens': '100000' })
    }
    // --- Gateway/proxy failure shapes (the `cloudflare` group drives these) ---------------------
    // A Métis operator's Cloudflare Worker sits between the app and the model, so it can fail in ways
    // a direct provider never does. Each of these is a shape that provider genuinely emits.
    if (url.includes('/auth-bad/')) {
      // The USER's METIS_PROXY_KEY is wrong — the one failure only they can fix.
      return errorJson(res, 401, 'Invalid METIS_PROXY_KEY')
    }
    if (url.includes('/forbidden/')) {
      return errorJson(res, 403, 'Forbidden')
    }
    if (url.includes('/upstream-error/')) {
      return errorJson(res, 500, 'Internal error')
    }
    if (url.includes('/gateway-cred/')) {
      // The OPERATOR's Cloudflare token is bad. The Worker deliberately maps its own 401/403 to 502 so
      // the app never tells the user to re-enter a proxy key that is perfectly fine.
      return errorJson(res, 502, '[metis-proxy-config] Cloudflare rejected this proxy account credential. The operator needs to check CLOUDFLARE_API_TOKEN and CF_ACCOUNT_ID.')
    }
    if (url.includes('/badbody/')) {
      // 200, but JSON instead of SSE — a misconfigured proxy that answers without streaming.
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ not: 'an sse stream' }))
    }
    if (url.includes('/midstream/')) {
      // Starts streaming, then the socket dies with no [DONE] — a dropped hop mid-answer.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'This answer starts fine' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ' and then stops' } }] })}\n\n`)
      return setTimeout(() => res.destroy(), 400)
    }
    if (url.includes('/hang/')) {
      return // accept and never answer: exercises the client-side timeout, not the server's
    }
    // default: healthy
    return sse(res, { 'x-ratelimit-remaining-tokens': '90000', 'x-ratelimit-limit-tokens': '100000' })
  })
}

const server = TLS ? https.createServer(TLS, handler) : http.createServer(handler)
server.listen(PORT, '127.0.0.1', () => console.log(`listening ${TLS ? 'https' : 'http'} ${PORT}`))
