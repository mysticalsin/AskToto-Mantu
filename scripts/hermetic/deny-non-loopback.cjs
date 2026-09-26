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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1'])

function isLoopback(host) {
  if (!host) return true // no host = the connect(path, ...) Unix-domain-socket form
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
  return options.host ?? '127.0.0.1' // net's own default when only a port is given
}

const originalConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function hermeticConnect(...args) {
  const host = targetHost(args)
  if (!isLoopback(host)) {
    const error = new Error(
      `HERMETIC_NETWORK_DENIED: blocked a connect() to non-loopback host "${host}" — ` +
        'M2-0190 isolation-canary preload only allows loopback traffic.'
    )
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
