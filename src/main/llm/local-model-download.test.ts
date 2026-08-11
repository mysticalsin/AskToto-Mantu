import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const source = readFileSync(join(REPO_ROOT, 'src', 'main', 'llm', 'local-model-download.ts'), 'utf8')

/**
 * The weights are no longer shipped inside the installer, so this module is now the ONLY place
 * installed application code fetches model bytes from the network. Bundling used to provide the
 * supply-chain guarantee; these checks are what replace it. They are source-level on purpose — the
 * download itself is a ~728 MB network operation that a unit test must not perform, but the rules that
 * make it safe are structural and can be asserted directly.
 */
describe('local model first-run downloader', () => {
  it('verifies the pinned sha256 and refuses to keep a mismatch', () => {
    expect(source).toMatch(/sha256/)
    // A mismatching download must be removed, never left where a later run would trust its presence.
    expect(source).toMatch(/does not match the pinned/)
    expect(source).toMatch(/rmSync\(partial, \{ force: true \}\)/)
  })

  it('checks the declared Content-Length before writing any bytes', () => {
    // Catches a redirect to a login/error page or a swapped asset without streaming it to disk first.
    expect(source).toMatch(/content-length/)
    expect(source).toMatch(/server declared/)
  })

  it('writes to a .partial file and renames only after verification', () => {
    const partialIdx = source.indexOf('`${dest}.partial`')
    const renameIdx = source.indexOf('renameSync(partial, dest)')
    const shaCheckIdx = source.indexOf('does not match the pinned')
    expect(partialIdx).toBeGreaterThan(-1)
    expect(renameIdx).toBeGreaterThan(-1)
    // The rename must come AFTER the hash comparison, or a tampered file briefly exists under the real
    // name and a crash in between would leave it there permanently.
    expect(renameIdx).toBeGreaterThan(shaCheckIdx)
  })

  it('never throws — a failed download must not break app startup', () => {
    // Métis Local is one route among several. Offline, proxied, or disk-full machines keep working on
    // the cloud/CLI routes and retry next launch.
    expect(source).toMatch(/Resolves true when the model is ready\. Never throws/)
    expect(source).toMatch(/return false/)
  })

  it('deduplicates concurrent callers instead of racing for the same files', () => {
    expect(source).toMatch(/if \(inFlight\) return inFlight/)
  })

  it('uses https only', () => {
    // The request itself comes from node:https. node:http may be referenced ONLY as a type import
    // (IncomingMessage), which emits no runtime code and cannot originate a plaintext request.
    expect(source).toMatch(/import \{ get as httpsGet \} from 'node:https'/)
    const httpImports = source.match(/^import .*'node:http'.*$/gm) ?? []
    for (const line of httpImports) expect(line).toMatch(/^import type /)
    // No plaintext URL for weights, in any form.
    expect(source).not.toMatch(/http:\/\/[a-z]/i)
  })
})
