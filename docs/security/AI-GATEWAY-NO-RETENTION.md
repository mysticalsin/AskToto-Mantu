# AI Gateway: no content retention for protected Operator traffic

Scope: Operator inference routes (`/v1/use`, `/v1/ask`) that reach Cloudflare AI Gateway. Code:
`operator/src/ai-gateway.ts` (readback, readiness, headers), `operator/src/use.ts`, `operator/src/ask.ts`.

## Control set

| Layer | Control |
|---|---|
| Gateway configuration | The existing `default` gateway must read back as `collect_logs: false`, `cache_ttl: 0`, `logpush: false`, no OTEL exporters, no log classification. |
| Request headers (REST route) | `cf-aig-collect-log: true` (metadata-only entry), `cf-aig-collect-log-payload: false`, `cf-aig-skip-cache: true`. |
| Transport without a proven metadata-only result (for example a Worker AI binding) | `cf-aig-collect-log: false`, `cf-aig-collect-log-payload: false`, `cf-aig-skip-cache: true`. |
| Transport where neither is proven | `BLOCKED`: `gatewayPrivacyHeaders('unproven')` throws `GATEWAY_TRANSPORT_BLOCKED`; no request is sent. |
| Worker/CDN caching | Every Operator response carries `cache-control: no-store` (`operator/src/http.ts`); the gateway readback uses `cache: 'no-store'`. Inference is POST-only and never cached. |
| Traces | The per-request log line (`logRequest`) holds route, method, status, latency, device and ray id. No request or response body, prompt, or image is logged anywhere in the Operator. |

The metadata-only entry follows the owner decision D-12 (default: keep metadata-only gateway logs). That is `ASSUMED`
until the owner confirms it; flipping it means changing the single `rest` branch of `gatewayPrivacyHeaders`.

## Readiness states (per route)

| State | Meaning | Source |
|---|---|---|
| `UNREVIEWED` | No reviewed gateway exists (readback returned 404). Never auto-created; a human reviews and creates it. | `GATEWAY_REVIEW_REQUIRED` |
| `CONFIGURED` | Configuration readback passed immediately before the call. | `verifyDefaultGatewayPrivacy` resolves |
| `VERIFIED` | `CONFIGURED` plus the independent sink tests below passed. Recorded by a release gate, never claimed by the Worker. | release evidence |
| `BLOCKED` | Unsafe configuration, denied or unavailable readback, unverifiable response, or unproven transport. Protected traffic is refused with 503 and a `readiness` field. | any other error code |

A configuration readback is not an end-to-end retention certification.

## WebSocket-specific test plan

Realtime speech runs over a WebSocket, which the header contract above does not cover per message. Before any capture test:

1. Confirm the route type: is the socket proxied through AI Gateway, or does it bypass it to the provider? Record which.
2. With a synthetic tone or fixed test phrase (never meeting audio), open one session and stream a known marker phrase.
3. Search the gateway log export, the Worker log/trace stream, the provider dashboard and any object storage for the marker. Expect zero hits; metadata (route, status, duration, byte counts) only.
4. Repeat with the connection closed abnormally mid-stream and with a reconnect; verify no partial buffer or resumption cache persists.
5. Confirm no `Set-Cookie` or cache validators are returned on the upgrade response and that the upgrade path is never served from cache.
6. Record the outcome as `LIVE_VERIFIED` only after a run against the deployed route; a local or mocked run stays `LOCALLY_TESTED`.
7. Until step 1 to 5 pass for a route, that route stays `UNREVIEWED` or `BLOCKED` and carries no capture traffic.
