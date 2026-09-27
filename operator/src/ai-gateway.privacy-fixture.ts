/** R11 test transport only. A successful API envelope alone is not privacy proof. */
export function reviewedGatewayReply(): Response {
  return new Response(JSON.stringify({
    success: true,
    result: { id: 'default', collect_logs: false, cache_ttl: 0, logpush: false }
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

export const reviewedGatewayFetch: typeof fetch = async (input, init) => {
  if (!String(input).endsWith('/ai-gateway/gateways/default') || init?.method !== 'GET') {
    throw new Error('Test expected a read-only gateway preflight, not provisioning or inference')
  }
  return reviewedGatewayReply()
}
