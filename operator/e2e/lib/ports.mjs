/**
 * Free TCP port picker for the e2e boot (`../boot.mjs`): asks the OS for an ephemeral port by
 * binding to port 0, reads back what it chose, then releases it immediately so `wrangler dev` can
 * bind the same port a moment later. Small race (something else could grab the port in between),
 * accepted the same way every other "find a free port" test helper accepts it.
 */
import { createServer } from 'node:net'

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address ? address.port : null
      srv.close((err) => {
        if (err) return reject(err)
        if (!port) return reject(new Error('freePort: could not resolve an ephemeral port'))
        resolve(port)
      })
    })
  })
}
