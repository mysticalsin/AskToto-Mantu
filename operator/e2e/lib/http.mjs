/**
 * Side-effecting import: forces every `fetch()` in this process to connect directly, bypassing
 * whatever `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` env vars this sandbox sets for outbound WAN
 * traffic. Those env vars are correct and needed for `npx wrangler@4` itself (fetching the npm
 * package, workerd's one-time `request.cf` trace lookup) — that traffic is left alone, since only
 * `wrangler dev`'s own child process env is what those requests use. This process's own `fetch()`
 * calls, though, are all loopback traffic to the Worker we just booted (127.0.0.1), which the
 * sandbox's `NO_PROXY` already lists — but this Node build's default fetch dispatcher does not
 * reliably honor `NO_PROXY` for a bare IPv4 literal, so it silently misroutes the request through
 * the proxy and gets back a proxy debug page instead of the Worker's real response. Importing this
 * module once (any e2e file that calls `fetch()` does) fixes that for the whole process.
 */
import { Agent, setGlobalDispatcher } from 'undici'

setGlobalDispatcher(new Agent())
