import { mkdtemp, lstat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const authority = vi.hoisted(() => ({
  profilePath: '',
  visible: true,
  current: true
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => authority.profilePath,
    hasSingleInstanceLock: () => true
  }
}))
vi.mock('../asr-bundled-ensure', () => ({
  userDataSpeechPackRoot: () => join(authority.profilePath, 'speech-packs')
}))
vi.mock('../auth', () => ({
  captureMainPersistenceSessionBoundary: () => ({
    configured: true,
    principalAssociation: 'a'.repeat(64),
    isCurrent: () => authority.current
  })
}))
vi.mock('../settings-authority-history', () => ({
  captureSettingsAuthority: () => Object.freeze({}),
  isSettingsAuthorityCurrent: () => authority.current
}))
vi.mock('./bootstrap', () => ({ PERSISTENCE_NATIVE_KEY_INTENT: 'allowed' }))

const roots: string[] = []

afterEach(async () => {
  authority.profilePath = ''
  authority.visible = true
  authority.current = true
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('main-owned speech-pack root authority', () => {
  it('creates separate profile key and app-data payload roots under the captured authority', async () => {
    authority.profilePath = await mkdtemp(join(tmpdir(), 'metis-main-speech-pack-root-'))
    roots.push(authority.profilePath)
    const { captureMainSpeechPackRoot } = await import('./main-speech-pack-root')
    const lease = await captureMainSpeechPackRoot('create', { afterFirstShow: () => authority.visible })

    expect(lease.scope.profileNamespace).toHaveLength(64)
    expect(lease.scope.principalAssociation).toBe('a'.repeat(64))
    expect(lease.scope.intent).toBe('explicit-pack-maintenance')
    expect(lease.keyRootPath).toBe(join(authority.profilePath, 'component-ownership', 'speech-packs'))
    expect(lease.rootPath).toBe(join(authority.profilePath, 'speech-packs'))
    expect(lease.keyRootPath).not.toBe(lease.rootPath)
    expect(lease.keyRegistryRoot.bindingId).toBe(lease.keyRootBindingId)
    await lease.assertPhysicalCurrent()
    authority.visible = false
    expect(() => lease.scope.assertCurrent()).toThrow()
    await lease.dispose()
  })

  it('keeps an existing-root open read-only when the fixed purpose root is missing', async () => {
    authority.profilePath = await mkdtemp(join(tmpdir(), 'metis-main-speech-pack-readonly-'))
    roots.push(authority.profilePath)
    const { captureMainSpeechPackRoot } = await import('./main-speech-pack-root')
    await expect(
      captureMainSpeechPackRoot('open-existing', { afterFirstShow: () => authority.visible })
    ).rejects.toThrow()
    await expect(lstat(join(authority.profilePath, 'component-ownership'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(authority.profilePath, 'speech-packs'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
