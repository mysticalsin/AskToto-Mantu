import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkUpdatePublisher,
  loadAppUpdateYaml,
  parseUpdatePublisherNamesEnv,
  publisherList,
  updatePublisherProblem,
  verifyUpdateCodeSignatureEnabled
} from './check-update-publisher.mjs'

const temporaryDirectories: string[] = []
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'metis-update-publisher-test-'))
  temporaryDirectories.push(dir)
  return dir
}

describe('publisherList', () => {
  it('normalizes an absent, single-string, or array publisherName', () => {
    expect(publisherList(null)).toBeNull()
    expect(publisherList(undefined)).toBeNull()
    expect(publisherList('')).toEqual([''])
    expect(publisherList('Mantu')).toEqual(['Mantu'])
    expect(publisherList(['Mantu', 'MANTU GROUP SA'])).toEqual(['Mantu', 'MANTU GROUP SA'])
  })
})

describe('parseUpdatePublisherNamesEnv', () => {
  it('accepts an unset or empty value as "no transitional pin configured"', () => {
    expect(parseUpdatePublisherNamesEnv(undefined)).toEqual({ ok: true, list: null })
    expect(parseUpdatePublisherNamesEnv('')).toEqual({ ok: true, list: null })
    expect(parseUpdatePublisherNamesEnv('   ')).toEqual({ ok: true, list: null })
  })

  it('accepts a JSON array of non-empty strings', () => {
    expect(parseUpdatePublisherNamesEnv('["Mantu","MANTU GROUP SA"]')).toEqual({
      ok: true,
      list: ['Mantu', 'MANTU GROUP SA']
    })
  })

  it('rejects malformed JSON, non-arrays, empty arrays, and non-string/blank entries', () => {
    for (const raw of ['not json', '{}', '"Mantu"', '[]', '[""]', '["Mantu", ""]', '["Mantu", 42]', '[null]']) {
      const result = parseUpdatePublisherNamesEnv(raw)
      expect(result.ok, `expected ${raw} to be rejected`).toBe(false)
      expect(result.error).toBeTruthy()
    }
  })
})

describe('verifyUpdateCodeSignatureEnabled', () => {
  it('reads the real repository policy as enabled (electron-builder.yml:292)', () => {
    expect(verifyUpdateCodeSignatureEnabled(join(__dirname, '..'))).toBe(true)
  })

  it('fails closed (treats it as enabled) when the flag is missing or unparseable', () => {
    const dir = workspace()
    writeFileSync(join(dir, 'electron-builder.yml'), 'win:\n  executableName: Metis\n')
    expect(verifyUpdateCodeSignatureEnabled(dir)).toBe(true)
  })

  it('honors an explicit false', () => {
    const dir = workspace()
    writeFileSync(join(dir, 'electron-builder.yml'), 'win:\n  verifyUpdateCodeSignature: false\n')
    expect(verifyUpdateCodeSignatureEnabled(dir)).toBe(false)
  })
})

describe('loadAppUpdateYaml', () => {
  it('parses a real app-update.yml through the installed electron-updater js-yaml dependency', () => {
    const dir = workspace()
    const path = join(dir, 'app-update.yml')
    writeFileSync(path, 'provider: github\nowner: mysticalsin\nrepo: Metis-Releases\npublisherName:\n  - Mantu\n  - MANTU GROUP SA\n')
    expect(loadAppUpdateYaml(path)).toEqual({
      provider: 'github',
      owner: 'mysticalsin',
      repo: 'Metis-Releases',
      publisherName: ['Mantu', 'MANTU GROUP SA']
    })
  })
})

describe('updatePublisherProblem (design §2.7 items 2-3)', () => {
  it('fails a missing or empty pin while verifyUpdateCodeSignature is true — the state every public build is in today', () => {
    for (const publisherName of [null, undefined, []]) {
      const problem = updatePublisherProblem({ publisherName, verifyUpdateCodeSignature: true, expectedList: null })
      expect(problem, `expected a problem for publisherName=${JSON.stringify(publisherName)}`).toBeTruthy()
      expect(problem).toContain('no publisherName')
    }
  })

  it('does not require a pin when verifyUpdateCodeSignature is false', () => {
    expect(updatePublisherProblem({ publisherName: null, verifyUpdateCodeSignature: false, expectedList: null })).toBeNull()
  })

  it('requires the pin to exactly match WIN_UPDATE_PUBLISHER_NAMES in order and size', () => {
    const base = { publisherName: ['Mantu', 'MANTU GROUP SA'], verifyUpdateCodeSignature: true }
    expect(updatePublisherProblem({ ...base, expectedList: ['Mantu', 'MANTU GROUP SA'] })).toBeNull()
    expect(updatePublisherProblem({ ...base, expectedList: null })).toBeNull()
    expect(updatePublisherProblem({ ...base, expectedList: ['MANTU GROUP SA', 'Mantu'] })).toContain('does not exactly match')
    expect(updatePublisherProblem({ ...base, expectedList: ['Mantu'] })).toContain('does not exactly match')
    expect(updatePublisherProblem({ ...base, expectedList: ['Mantu', 'MANTU GROUP SA', 'Extra'] })).toContain('does not exactly match')
  })
})

describe('checkUpdatePublisher (design §2.7 item 4, verifier stubbed)', () => {
  it('calls the verifier with the parsed publisher list and the Setup.exe path, and passes on a null result', async () => {
    let calledWith: { list: unknown; exe: unknown } | null = null
    const result = await checkUpdatePublisher({
      appUpdatePath: 'fixture-app-update.yml',
      setupExePath: 'fixture/Metis-Setup-9.9.9.exe',
      verifyUpdateCodeSignature: true,
      expectedList: null,
      loadAppUpdateYaml: () => ({ publisherName: ['Mantu', 'MANTU GROUP SA'] }),
      verifySignature: async (list: unknown, exe: unknown) => { calledWith = { list, exe }; return null }
    })
    expect(calledWith).toEqual({ list: ['Mantu', 'MANTU GROUP SA'], exe: 'fixture/Metis-Setup-9.9.9.exe' })
    expect(result).toEqual({
      publisherName: ['Mantu', 'MANTU GROUP SA'],
      appUpdatePath: 'fixture-app-update.yml',
      setupExePath: 'fixture/Metis-Setup-9.9.9.exe'
    })
  })

  it('throws on a non-null verifier result and never masks the verifier detail', async () => {
    await expect(checkUpdatePublisher({
      appUpdatePath: 'fixture-app-update.yml',
      setupExePath: 'fixture/Metis-Setup-9.9.9.exe',
      verifyUpdateCodeSignature: true,
      loadAppUpdateYaml: () => ({ publisherName: ['Mantu'] }),
      verifySignature: async () => 'publisherNames: Mantu, raw info: {"Status":1}'
    })).rejects.toThrow(/REJECT its own next update.*publisherNames: Mantu/s)
  })

  it('never calls the verifier when the pin itself is already invalid (missing pin)', async () => {
    let verifierCalled = false
    await expect(checkUpdatePublisher({
      appUpdatePath: 'fixture-app-update.yml',
      setupExePath: 'fixture/Metis-Setup-9.9.9.exe',
      verifyUpdateCodeSignature: true,
      loadAppUpdateYaml: () => ({ publisherName: null }),
      verifySignature: async () => { verifierCalled = true; return null }
    })).rejects.toThrow(/no publisherName/)
    expect(verifierCalled).toBe(false)
  })

  it('never calls the verifier when the pin does not match WIN_UPDATE_PUBLISHER_NAMES', async () => {
    let verifierCalled = false
    await expect(checkUpdatePublisher({
      appUpdatePath: 'fixture-app-update.yml',
      setupExePath: 'fixture/Metis-Setup-9.9.9.exe',
      verifyUpdateCodeSignature: true,
      expectedList: ['MANTU GROUP SA'],
      loadAppUpdateYaml: () => ({ publisherName: ['Mantu'] }),
      verifySignature: async () => { verifierCalled = true; return null }
    })).rejects.toThrow(/does not exactly match/)
    expect(verifierCalled).toBe(false)
  })

  it('surfaces a YAML read failure instead of silently treating it as no pin', async () => {
    await expect(checkUpdatePublisher({
      appUpdatePath: 'missing-app-update.yml',
      setupExePath: 'fixture/Metis-Setup-9.9.9.exe',
      verifyUpdateCodeSignature: true,
      loadAppUpdateYaml: () => { throw new Error('ENOENT: no such file') },
      verifySignature: async () => null
    })).rejects.toThrow(/could not read missing-app-update\.yml/)
  })
})
