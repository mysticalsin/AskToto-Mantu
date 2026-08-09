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
    // default: healthy
    return sse(res, { 'x-ratelimit-remaining-tokens': '90000', 'x-ratelimit-limit-tokens': '100000' })
  })
}

const server = TLS ? https.createServer(TLS, handler) : http.createServer(handler)
server.listen(PORT, '127.0.0.1', () => console.log(`listening ${TLS ? 'https' : 'http'} ${PORT}`))
