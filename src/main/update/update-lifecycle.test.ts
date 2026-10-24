import { describe, expect, it } from 'vitest'
import type { UpdateLifecycleState } from '@shared/update-lifecycle'
import { reconcileBootReceipt, transition, verifyStagedDownload, type StagedVerifyDeps } from './update-lifecycle'

const idle: UpdateLifecycleState = { phase: 'idle' }

describe('G86 transition — the update state machine', () => {
  it('a background offer while busy waits in available-deferred', () => {
    const next = transition({ phase: 'checking' }, { type: 'available', version: '2.1.0', busy: ['meeting'] })
    expect(next).toEqual({ phase: 'available-deferred', version: '2.1.0', deferred: ['meeting'] })
  })

  it('an idle offer is simply available', () => {
    expect(transition({ phase: 'checking' }, { type: 'available', version: '2.1.0', busy: [] }).phase).toBe('available')
  })

  it('download, then verify, then ready', () => {
    let s = transition({ phase: 'available', version: '2.1.0' }, { type: 'download-start' })
    expect(s.phase).toBe('downloading')
    s = transition(s, { type: 'downloaded', version: '2.1.0' })
    expect(s.phase).toBe('verifying')
    expect(transition(s, { type: 'verified', ok: true })).toEqual({ phase: 'ready', version: '2.1.0' })
    expect(transition(s, { type: 'verified', ok: false }).phase).toBe('verify-failed')
  })

  it('install while busy defers and never reaches installing', () => {
    const next = transition({ phase: 'ready', version: '2.1.0' }, { type: 'install', busy: ['task', 'meeting'] })
    expect(next).toEqual({ phase: 'install-deferred', version: '2.1.0', deferred: ['task', 'meeting'] })
  })

  it('install while idle moves to installing', () => {
    expect(transition({ phase: 'ready', version: '2.1.0' }, { type: 'install', busy: [] }).phase).toBe('installing')
  })

  it('a deferred install that turns idle goes back to ready, with no relaunch', () => {
    const next = transition({ phase: 'install-deferred', version: '2.1.0', deferred: ['meeting'] }, { type: 'idle' })
    expect(next).toEqual({ phase: 'ready', version: '2.1.0' })
  })

  it('a deferred offer that turns idle becomes available', () => {
    expect(
      transition({ phase: 'available-deferred', version: '2.1.0', deferred: ['task'] }, { type: 'idle' }).phase
    ).toBe('available')
  })

  it('an event that does not apply returns the same state and never throws', () => {
    expect(transition(idle, { type: 'install', busy: [] })).toBe(idle)
    expect(transition(idle, { type: 'verified', ok: true })).toBe(idle)
    const ready: UpdateLifecycleState = { phase: 'ready', version: '2.1.0' }
    expect(transition(ready, { type: 'downloaded', version: '2.1.0' })).toBe(ready)
  })

  it('a boot receipt only applies to a fresh process', () => {
    const boot = { type: 'boot', outcome: 'post-verify', fromVersion: '2.0.0', toVersion: '2.1.0' } as const
    expect(transition(idle, boot)).toEqual({ phase: 'post-verify', fromVersion: '2.0.0', version: '2.1.0' })
    const busy: UpdateLifecycleState = { phase: 'checking' }
    expect(transition(busy, boot)).toBe(busy)
  })

  it('failed helper re-verification quarantines and carries the rollback link', () => {
    const post: UpdateLifecycleState = { phase: 'post-verify', fromVersion: '2.0.0', version: '2.1.0' }
    const url = 'https://github.com/mysticalsin/Metis-Releases/releases/tag/v2.0.0'
    const next = transition(post, {
      type: 'helpers',
      ok: false,
      helpers: [{ id: 'mac-helper', result: 'fail', reason: 'codesign' }],
      rollbackUrl: url
    })
    expect(next.phase).toBe('helpers-quarantined')
    expect(next.rollbackUrl).toBe(url)
    expect(transition(post, { type: 'helpers', ok: true, helpers: [] }).phase).toBe('current')
  })
})

function stagedDeps(over: Partial<StagedVerifyDeps> = {}): StagedVerifyDeps {
  return {
    currentVersion: '2.0.0',
    offeredVersion: '2.1.0',
    fileSize: async () => 100,
    sha512Base64: async () => 'good-hash',
    ...over
  }
}
const info = (over: Record<string, unknown> = {}): Parameters<typeof verifyStagedDownload>[0] => ({
  version: '2.1.0',
  downloadedFile: '/cache/pending/Metis-2.1.0.zip',
  files: [{ url: 'Metis-2.1.0.zip', sha512: 'good-hash', size: 100 }],
  ...over
})

describe('G86 verifyStagedDownload — a staged file is trusted only after its hash and version check out', () => {
  it('accepts a matching hash, size and newer version', async () => {
    expect(await verifyStagedDownload(info(), stagedDeps())).toEqual({ ok: true })
  })

  it('rejects a sha512 mismatch', async () => {
    expect(await verifyStagedDownload(info(), stagedDeps({ sha512Base64: async () => 'other' }))).toEqual({
      ok: false,
      reason: 'hash-mismatch'
    })
  })

  it('fails closed when no feed entry matches the file name', async () => {
    const result = await verifyStagedDownload(
      info({ files: [{ url: 'Other.zip', sha512: 'good-hash' }] }),
      stagedDeps()
    )
    expect(result).toEqual({ ok: false, reason: 'no-match' })
  })

  it('rejects a size mismatch and a missing file', async () => {
    expect(await verifyStagedDownload(info(), stagedDeps({ fileSize: async () => 7 }))).toEqual({
      ok: false,
      reason: 'size-mismatch'
    })
    expect(await verifyStagedDownload(info(), stagedDeps({ fileSize: async () => null }))).toEqual({
      ok: false,
      reason: 'no-file'
    })
  })

  it('rejects a version that is not newer or not the one offered', async () => {
    expect(await verifyStagedDownload(info({ version: '2.0.0' }), stagedDeps())).toEqual({
      ok: false,
      reason: 'not-newer'
    })
    expect(await verifyStagedDownload(info({ version: '2.2.0' }), stagedDeps())).toEqual({
      ok: false,
      reason: 'version-mismatch'
    })
  })
})

describe('G86 reconcileBootReceipt — what the first boot after an install means', () => {
  const receipt = { schema: 1, fromVersion: '2.0.0', toVersion: '2.1.0', at: 1 } as const
  it('no receipt: nothing to do', () => expect(reconcileBootReceipt(null, '2.0.0')).toBe('none'))
  it('still on the old version: the install did not happen', () =>
    expect(reconcileBootReceipt(receipt, '2.0.0')).toBe('install-failed'))
  it('on the new version: verify the helpers', () => expect(reconcileBootReceipt(receipt, '2.1.0')).toBe('post-verify'))
  it('any other version is reported, not guessed at', () =>
    expect(reconcileBootReceipt(receipt, '1.9.0')).toBe('unknown-version'))
})
