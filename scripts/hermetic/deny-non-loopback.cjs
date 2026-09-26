'use strict'
// W0-HERMETIC (M2-0190) — loaded via `NODE_OPTIONS="--require <this file>"` for exactly one purpose:
// mechanically PROVE a wrapped process never opened a TCP connection to anything but loopback, rather
// than trusting a CLI flag (`wrangler dev --local`) to have actually stayed local. Every TCP connect —
// plain, or the one `tls.connect`/undici/http.Agent open underneath — goes through
// `net.Socket.prototype.connect`, so patching that one choke point covers all of them without needing a
// real proxy or an OS-level firewall inside a CI runner.
//
// Deliberately narrow: it only inspects the destination of a connect() call and fails it if that
// destination isn't loopback or a Unix domain socket. It never touches DNS resolution, UDP, or a
// server's own listen()/accept() path (a bare lookup with no connect() that follows it leaks nothing by
// itself, and an accepted inbound connection never goes through connect() at all).
//
// CommonJS (not the repo's usual .mjs) because `--require` only loads CJS; `--import` would need an ESM
// loader hook for the same effect and buys nothing here.
const net = require('node:net')
const fs = require('node:fs')

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1'])

function isLoopback(host) {
  if (LOOPBACK_HOSTS.has(host)) return true
  // net.isIPv4, not a string prefix: "127.example.com" starts with "127." too, but resolves through
  // DNS to whatever that name points at, not to loopback.
  return net.isIPv4(host) && host.startsWith('127.')
}

/**
 * Pulls the intended destination host out of any of net.Socket#connect's call shapes.
 *
 * net.connect()/net.createConnection() — and everything built on them: http.Agent's own
 * createConnection, undici's plain-http path — normalize their arguments once and call
 * Socket#connect with the already-normalized `[options, cb]` ARRAY, tagged so it is never
 * re-normalized. A direct `socket.connect(port, host)` (what tls.connect() uses) never goes through
 * that normalization, so it has to be done here instead. Array.isArray(args[0]) tells the two shapes
 * apart; net._normalizeArgs reproduces net's own normalization for the second one, so both paths read
 * the same options object net itself would.
 */
function targetHost(args) {
  const [options] = Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args)
  if (options.path) return null // Unix domain socket — always allowed
  return options.host ?? 'localhost' // net's own default (options.host || 'localhost') when only a port is given
}

const originalConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function hermeticConnect(...args) {
  const host = targetHost(args)
  if (host === null) return originalConnect.apply(this, args) // Unix domain socket — always allowed
  if (!isLoopback(host)) {
    // Match net's own contract for an in-flight connect(): `connecting` is true until it resolves.
    // Without this, http.Agent's own "is this socket already usable?" check sees a falsy `connecting`
    // on a brand-new socket and writes the request head to it immediately — before this denial's own
    // queued destroy() runs — which fails with ERR_SOCKET_CLOSED (no connection handle was ever
    // created) and masks this error entirely.
    this.connecting = true
    const message =
      `HERMETIC_NETWORK_DENIED: blocked a connect() to non-loopback host "${host}" — ` +
      'M2-0190 isolation-canary preload only allows loopback traffic.'
    // Round-2 finding: a caller that catches the connect() failure and only logs it (wrangler's own
    // metrics dispatcher does exactly this, at debug level, when WRANGLER_SEND_METRICS is left unset)
    // can exit 0 with no visible trace of the denial. Reporting has to happen HERE, synchronously, so
    // it can never depend on whether — or how — the caller handles the error this function also raises
    // below. fd 2 is written directly (not console.error, which can be monkey-patched or buffered)
    // so a test can assert on the child process's real stderr regardless of its exit code.
    try {
      fs.writeSync(2, `${message}\n`)
    } catch {
      // stderr can be closed or redirected away in some embedding contexts; destroy(error) below is
      // still the caller-visible signal in that case.
    }
    const error = new Error(message)
    error.code = 'HERMETIC_NETWORK_DENIED'
    // Match net's own contract for a failed connection: asynchronous, and via destroy(err) — which
    // emits 'error' and then 'close', exactly what a real failed connect() does — never a bare
    // emit('error') that leaves the socket undestroyed and never emits 'close'. queueMicrotask fires
    // after the caller's own synchronous `.connect(...).on('error', ...)` chain has run, so the
    // listener is always attached in time.
    queueMicrotask(() => this.destroy(error))
    return this
  }
  return originalConnect.apply(this, args)
}
