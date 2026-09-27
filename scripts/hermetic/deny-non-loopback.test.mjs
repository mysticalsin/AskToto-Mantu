import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// M2-0190 — deny-non-loopback.cjs patches net.Socket.prototype.connect(), which every connect() shape
// eventually reaches, but by different call shapes: net.connect()/net.createConnection() (and everything
// built on them: http.Agent, undici's plain-http path) call Socket#connect with an already-normalized
// [options, cb] ARRAY, a different shape from the (port, host) form tls.connect() uses. These are the
// direct behaviour proof: spawn a real child process under the preload and assert it is denied quickly,
// for every shape that reaches Socket#connect, plus a positive control proving loopback traffic still
// works.
//
// 192.0.2.1 is TEST-NET-1 (RFC 5737) — guaranteed non-routable and non-existent, so nothing real is ever
// contacted even while this preload fails to deny it.
const HERE = dirname(fileURLToPath(import.meta.url))
const PRELOAD = join(HERE, 'deny-non-loopback.cjs')
const TIMEOUT_MS = 5_000

const DENIED_SCRIPTS = {
  'net.connect()': `
    const net = require('net')
    const s = net.connect(80, '192.0.2.1')
    s.on('error', (e) => { console.log(e.code); process.exit(e.code === 'HERMETIC_NETWORK_DENIED' ? 0 : 1) })
    s.on('connect', () => { console.log('CONNECTED'); process.exit(1) })
  `,
  'http.get()': `
    const http = require('http')
    const req = http.get('http://192.0.2.1/', () => { console.log('RESPONDED'); process.exit(1) })
    req.on('error', (e) => { console.log(e.code); process.exit(e.code === 'HERMETIC_NETWORK_DENIED' ? 0 : 1) })
  `,
  'tls.connect()': `
    const tls = require('tls')
    const s = tls.connect(443, '192.0.2.1')
    s.on('error', (e) => { console.log(e.code); process.exit(e.code === 'HERMETIC_NETWORK_DENIED' ? 0 : 1) })
    s.on('secureConnect', () => { console.log('CONNECTED'); process.exit(1) })
  `
}

for (const [label, script] of Object.entries(DENIED_SCRIPTS)) {
  test(`${label} to a non-loopback host is denied`, () => {
    const result = spawnSync(process.execPath, ['--require', PRELOAD, '-e', script], {
      timeout: TIMEOUT_MS,
      encoding: 'utf8'
    })
    assert.equal(
      result.status,
      0,
      `expected HERMETIC_NETWORK_DENIED, got status=${result.status} signal=${result.signal} ` +
        `stdout=${result.stdout} stderr=${result.stderr}`
    )
    assert.equal(result.stdout.trim(), 'HERMETIC_NETWORK_DENIED')
  })
}

// A caller that catches the connect() error and swallows it (wrangler's own metrics dispatcher does
// this, logging only at debug level) must still be unable to exit 0 with nothing on stdout to show a
// denial ever happened. The preload reports a denial on stderr unconditionally, never only when the
// caller happens to let the error surface.
test('a denial reaches stderr even when the caller swallows the error and the process exits 0', () => {
  const script = `
    const net = require('net')
    const s = net.connect(80, '192.0.2.1')
    s.on('error', () => { process.exit(0) }) // deliberately swallowed — exit status alone must not read as clean
  `
  const result = spawnSync(process.execPath, ['--require', PRELOAD, '-e', script], {
    timeout: TIMEOUT_MS,
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, `expected the swallowed exit to still be 0, got status=${result.status}`)
  assert.match(
    result.stderr,
    /HERMETIC_NETWORK_DENIED/,
    `expected stderr to carry the denial regardless of exit status; stderr=${result.stderr}`
  )
})

test('positive control: a real loopback connect() still succeeds under the preload', () => {
  const script = `
    const net = require('net')
    const server = net.createServer((sock) => { sock.end() })
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      const s = net.connect(port, '127.0.0.1')
      s.on('connect', () => { console.log('CONNECTED'); server.close(); process.exit(0) })
      s.on('error', (e) => { console.log(e.code); server.close(); process.exit(1) })
    })
  `
  const result = spawnSync(process.execPath, ['--require', PRELOAD, '-e', script], {
    timeout: TIMEOUT_MS,
    encoding: 'utf8'
  })
  assert.equal(
    result.status,
    0,
    `expected a successful loopback connect, got status=${result.status} signal=${result.signal} ` +
      `stdout=${result.stdout} stderr=${result.stderr}`
  )
  assert.equal(result.stdout.trim(), 'CONNECTED')
})
