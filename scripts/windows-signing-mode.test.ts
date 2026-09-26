import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  WINDOWS_SIGNING_MODES,
  SIGNING_MODE_CODES,
  resolveWindowsSigningMode,
  describeSigningModeFailure,
  buildWindowsSigningOverlay
} from './lib/windows-signing-mode.mjs'

// Resolve builder-util-runtime the way the rest of the repo does: from electron-updater's own
// dependency tree (scripts/updater-yaml-compat.test.ts:24-27), not by assuming it happens to be
// hoisted to the top-level node_modules. This is the exact package whose parseDn semantics the
// resolver's publisher-list matching has to agree with.
const repoRequire = createRequire(import.meta.url)
const electronUpdaterPkg = repoRequire.resolve('electron-updater/package.json')
const electronUpdaterRequire = createRequire(electronUpdaterPkg)
const { parseDn } = electronUpdaterRequire('builder-util-runtime') as { parseDn: (seq: string) => Map<string, string> }

type Env = Record<string, string | undefined>

const BASE_PFX_ENV: Env = {
  PATH: process.env.PATH || '',
  GH_TOKEN: 'synthetic-gh-token',
  WIN_SIGNING_MODE: 'pfx',
  WIN_CSC_LINK: 'synthetic-pfx-base64-payload',
  WIN_CSC_KEY_PASSWORD: 'synthetic-pfx-password',
  WIN_CSC_EXPECTED_SUBJECT: 'Mantu'
}

const BASE_AZURE_ENV: Env = {
  PATH: process.env.PATH || '',
  GH_TOKEN: 'synthetic-gh-token',
  WIN_SIGNING_MODE: 'azure',
  WIN_AZURE_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net',
  WIN_AZURE_SIGNING_ACCOUNT: 'synthetic-account',
  WIN_AZURE_CERT_PROFILE: 'synthetic-profile',
  WIN_AZURE_PUBLISHER_NAME: 'MANTU GROUP SA',
  WIN_CSC_EXPECTED_SUBJECT: 'MANTU GROUP SA'
}

function without(env: Env, ...keys: string[]): Env {
  const copy = { ...env }
  for (const key of keys) delete copy[key]
  return copy
}

describe('WINDOWS_SIGNING_MODES / SIGNING_MODE_CODES', () => {
  it('exposes exactly pfx and azure', () => {
    expect(WINDOWS_SIGNING_MODES).toEqual(['pfx', 'azure'])
  })

  it('exposes the full fixed code enum the shared contract specifies', () => {
    expect(SIGNING_MODE_CODES).toEqual({
      REQUIRED: 'SIGNING_MODE_REQUIRED',
      INVALID: 'SIGNING_MODE_INVALID',
      AMBIGUOUS: 'SIGNING_MODE_AMBIGUOUS',
      PFX_INCOMPLETE: 'PFX_CONFIG_INCOMPLETE',
      AZURE_INCOMPLETE: 'AZURE_CONFIG_INCOMPLETE',
      ENDPOINT_INVALID: 'AZURE_ENDPOINT_INVALID',
      AZURE_ENV_FORBIDDEN: 'AZURE_ENV_FORBIDDEN',
      CSC_FALLBACK_FORBIDDEN: 'CSC_FALLBACK_FORBIDDEN',
      PUBLISHER_LIST_INVALID: 'PUBLISHER_LIST_INVALID',
      PUBLISHER_LIST_EXCLUDES_SIGNER: 'PUBLISHER_LIST_EXCLUDES_SIGNER',
      GH_TOKEN_MISSING: 'GH_TOKEN_MISSING'
    })
  })
})

describe('resolveWindowsSigningMode: the fail-closed matrix', () => {
  it('accepts a complete pfx configuration', () => {
    expect(resolveWindowsSigningMode(BASE_PFX_ENV)).toEqual({
      ok: true, mode: 'pfx', expectedSubject: 'Mantu', updatePublisherNames: null, azure: null
    })
  })

  it('accepts a complete azure configuration, defaulting the publisher list', () => {
    expect(resolveWindowsSigningMode(BASE_AZURE_ENV)).toEqual({
      ok: true,
      mode: 'azure',
      expectedSubject: 'MANTU GROUP SA',
      updatePublisherNames: ['MANTU GROUP SA'],
      azure: {
        endpoint: 'https://weu.codesigning.azure.net',
        account: 'synthetic-account',
        certificateProfile: 'synthetic-profile',
        publisherName: 'MANTU GROUP SA',
        identityEku: null
      }
    })
  })

  it('requires a GitHub release token before anything else is evaluated', () => {
    const result = resolveWindowsSigningMode({})
    expect(result).toEqual({ ok: false, code: SIGNING_MODE_CODES.GH_TOKEN_MISSING, variables: ['GH_TOKEN', 'GITHUB_TOKEN'] })
  })

  it('accepts GITHUB_TOKEN as an alternative to GH_TOKEN', () => {
    const env = without(BASE_PFX_ENV, 'GH_TOKEN')
    expect(resolveWindowsSigningMode({ ...env, GITHUB_TOKEN: 'synthetic' }).ok).toBe(true)
  })

  it('requires WIN_SIGNING_MODE to be set', () => {
    const env = without(BASE_PFX_ENV, 'WIN_SIGNING_MODE')
    expect(resolveWindowsSigningMode(env)).toEqual({
      ok: false, code: SIGNING_MODE_CODES.REQUIRED, variables: ['WIN_SIGNING_MODE']
    })
  })

  it('rejects a signing mode outside pfx|azure', () => {
    expect(resolveWindowsSigningMode({ ...BASE_PFX_ENV, WIN_SIGNING_MODE: 'both' })).toEqual({
      ok: false, code: SIGNING_MODE_CODES.INVALID, variables: ['WIN_SIGNING_MODE']
    })
  })

  it('forbids the generic CSC fallback in pfx mode', () => {
    const result = resolveWindowsSigningMode({ ...BASE_PFX_ENV, CSC_LINK: 'synthetic-fallback' })
    expect(result).toEqual({ ok: false, code: SIGNING_MODE_CODES.CSC_FALLBACK_FORBIDDEN, variables: ['CSC_LINK'] })
  })

  it('forbids the generic CSC fallback in azure mode too', () => {
    const result = resolveWindowsSigningMode({ ...BASE_AZURE_ENV, CSC_KEY_PASSWORD: 'synthetic-fallback' })
    expect(result).toEqual({ ok: false, code: SIGNING_MODE_CODES.CSC_FALLBACK_FORBIDDEN, variables: ['CSC_KEY_PASSWORD'] })
  })

  it('flags both bare CSC vars by name when both are present', () => {
    const result = resolveWindowsSigningMode({ ...BASE_PFX_ENV, CSC_LINK: 'x', CSC_KEY_PASSWORD: 'y' })
    expect(result.code).toBe(SIGNING_MODE_CODES.CSC_FALLBACK_FORBIDDEN)
    expect(result.variables).toEqual(['CSC_LINK', 'CSC_KEY_PASSWORD'])
  })

  const FORBIDDEN_AZURE_ENV_VARS = [
    'AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_CLIENT_SECRET',
    'AZURE_CLIENT_CERTIFICATE_PATH', 'AZURE_FEDERATED_TOKEN_FILE', 'AZURE_USERNAME', 'AZURE_PASSWORD'
  ]

  it.each(FORBIDDEN_AZURE_ENV_VARS)('forbids %s in the build env in azure mode', (name) => {
    const result = resolveWindowsSigningMode({ ...BASE_AZURE_ENV, [name]: 'synthetic' })
    expect(result).toEqual({ ok: false, code: SIGNING_MODE_CODES.AZURE_ENV_FORBIDDEN, variables: [name] })
  })

  it('forbids the same Azure credential variables in pfx mode', () => {
    const result = resolveWindowsSigningMode({ ...BASE_PFX_ENV, AZURE_CLIENT_SECRET: 'synthetic' })
    expect(result).toEqual({ ok: false, code: SIGNING_MODE_CODES.AZURE_ENV_FORBIDDEN, variables: ['AZURE_CLIENT_SECRET'] })
  })

  it('flags azure-only inputs present while in pfx mode as ambiguous', () => {
    const result = resolveWindowsSigningMode({ ...BASE_PFX_ENV, WIN_AZURE_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net' })
    expect(result).toEqual({ ok: false, code: SIGNING_MODE_CODES.AMBIGUOUS, variables: ['WIN_AZURE_SIGNING_ENDPOINT'] })
  })

  it('flags pfx-only inputs present while in azure mode as ambiguous', () => {
    const result = resolveWindowsSigningMode({ ...BASE_AZURE_ENV, WIN_CSC_LINK: 'synthetic' })
    expect(result).toEqual({ ok: false, code: SIGNING_MODE_CODES.AMBIGUOUS, variables: ['WIN_CSC_LINK'] })
  })

  it('does not treat the shared WIN_CSC_EXPECTED_SUBJECT as ambiguous in either mode', () => {
    expect(resolveWindowsSigningMode(BASE_PFX_ENV).ok).toBe(true)
    expect(resolveWindowsSigningMode(BASE_AZURE_ENV).ok).toBe(true)
  })

  it.each(['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'WIN_CSC_EXPECTED_SUBJECT'])(
    'reports pfx mode incomplete and names %s when it alone is missing',
    (name) => {
      const result = resolveWindowsSigningMode(without(BASE_PFX_ENV, name))
      expect(result).toEqual({ ok: false, code: SIGNING_MODE_CODES.PFX_INCOMPLETE, variables: [name] })
    }
  )

  it.each(['WIN_AZURE_SIGNING_ENDPOINT', 'WIN_AZURE_SIGNING_ACCOUNT', 'WIN_AZURE_CERT_PROFILE', 'WIN_AZURE_PUBLISHER_NAME', 'WIN_CSC_EXPECTED_SUBJECT'])(
    'reports azure mode incomplete and names %s when it alone is missing',
    (name) => {
      const result = resolveWindowsSigningMode(without(BASE_AZURE_ENV, name))
      expect(result).toEqual({ ok: false, code: SIGNING_MODE_CODES.AZURE_INCOMPLETE, variables: [name] })
    }
  )

  it('rejects an azure endpoint outside *.codesigning.azure.net', () => {
    const result = resolveWindowsSigningMode({ ...BASE_AZURE_ENV, WIN_AZURE_SIGNING_ENDPOINT: 'https://evil.example.com' })
    expect(result).toEqual({ ok: false, code: SIGNING_MODE_CODES.ENDPOINT_INVALID, variables: ['WIN_AZURE_SIGNING_ENDPOINT'] })
  })

  it.each([
    'https://weu.codesigning.azure.net',
    'https://swn.codesigning.azure.net',
    'https://neu.codesigning.azure.net/'
  ])('accepts a well-formed regional endpoint: %s', (endpoint) => {
    expect(resolveWindowsSigningMode({ ...BASE_AZURE_ENV, WIN_AZURE_SIGNING_ENDPOINT: endpoint }).ok).toBe(true)
  })

  it.each([
    'http://weu.codesigning.azure.net',
    'https://WEU.codesigning.azure.net',
    'https://weu.codesigning.azure.net/extra',
    'https://codesigning.azure.net'
  ])('rejects a malformed endpoint: %s', (endpoint) => {
    const result = resolveWindowsSigningMode({ ...BASE_AZURE_ENV, WIN_AZURE_SIGNING_ENDPOINT: endpoint })
    expect(result.code).toBe(SIGNING_MODE_CODES.ENDPOINT_INVALID)
  })

  it('rejects a malformed optional identity EKU', () => {
    const result = resolveWindowsSigningMode({ ...BASE_AZURE_ENV, WIN_AZURE_IDENTITY_EKU: 'not-an-oid' })
    expect(result).toEqual({ ok: false, code: SIGNING_MODE_CODES.AZURE_INCOMPLETE, variables: ['WIN_AZURE_IDENTITY_EKU'] })
  })

  it('accepts a well-formed identity EKU and carries it through', () => {
    const result = resolveWindowsSigningMode({ ...BASE_AZURE_ENV, WIN_AZURE_IDENTITY_EKU: '1.3.6.1.4.1.311.97.1.1' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.azure?.identityEku).toBe('1.3.6.1.4.1.311.97.1.1')
  })

  it.each(['not-json', '{}', '[]', '["ok", 5]', '[""]', '["  "]', '"just-a-string"', '123'])(
    'rejects a malformed WIN_UPDATE_PUBLISHER_NAMES: %s',
    (raw) => {
      const result = resolveWindowsSigningMode({ ...BASE_AZURE_ENV, WIN_UPDATE_PUBLISHER_NAMES: raw })
      expect(result).toEqual({ ok: false, code: SIGNING_MODE_CODES.PUBLISHER_LIST_INVALID, variables: ['WIN_UPDATE_PUBLISHER_NAMES'] })
    }
  )

  it('rejects a publisher list whose plain entries do not match the expected CN', () => {
    const result = resolveWindowsSigningMode({
      ...BASE_AZURE_ENV, WIN_UPDATE_PUBLISHER_NAMES: JSON.stringify(['Some Other Name'])
    })
    expect(result).toEqual({
      ok: false, code: SIGNING_MODE_CODES.PUBLISHER_LIST_EXCLUDES_SIGNER,
      variables: ['WIN_UPDATE_PUBLISHER_NAMES', 'WIN_CSC_EXPECTED_SUBJECT']
    })
  })

  it('accepts a publisher list whose plain entry matches the expected CN exactly', () => {
    const result = resolveWindowsSigningMode({
      ...BASE_AZURE_ENV, WIN_UPDATE_PUBLISHER_NAMES: JSON.stringify(['MANTU GROUP SA'])
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.updatePublisherNames).toEqual(['MANTU GROUP SA'])
  })

  it('accepts a CN-only DN-style entry ("CN=<value>") against a plain expected CN', () => {
    const result = resolveWindowsSigningMode({
      ...BASE_AZURE_ENV, WIN_UPDATE_PUBLISHER_NAMES: JSON.stringify(['CN=MANTU GROUP SA'])
    })
    expect(result.ok).toBe(true)
  })

  it('rejects a multi-field DN entry when the expected subject is CN-only (cannot confirm the other fields)', () => {
    // This is the fail-closed side of "subset compare": WIN_CSC_EXPECTED_SUBJECT is deliberately a
    // plain CN (design decision D3 = option A), so an entry naming extra DN fields can never be
    // confirmed against it and must not be treated as accepted.
    const result = resolveWindowsSigningMode({
      ...BASE_AZURE_ENV, WIN_UPDATE_PUBLISHER_NAMES: JSON.stringify(['CN=MANTU GROUP SA, O=MANTU GROUP SA'])
    })
    expect(result.code).toBe(SIGNING_MODE_CODES.PUBLISHER_LIST_EXCLUDES_SIGNER)
  })

  it('accepts a DN-subset entry against a full DN expected subject, via builder-util-runtime parseDn semantics', () => {
    const expectedSubject = 'CN=MANTU GROUP SA, O=MANTU GROUP SA, C=CH'
    const entry = 'CN=MANTU GROUP SA, O=MANTU GROUP SA'
    // Cross-check against the installed package itself so this module's in-repo port can never
    // silently drift from the real electron-updater/builder-util-runtime behaviour.
    const parsedEntry = parseDn(entry)
    const parsedSubject = parseDn(expectedSubject)
    expect([...parsedEntry.keys()].every((key) => parsedEntry.get(key) === parsedSubject.get(key))).toBe(true)

    const result = resolveWindowsSigningMode({
      ...BASE_AZURE_ENV, WIN_CSC_EXPECTED_SUBJECT: expectedSubject, WIN_UPDATE_PUBLISHER_NAMES: JSON.stringify([entry])
    })
    expect(result.ok).toBe(true)
  })

  it('rejects a DN entry whose CN differs even though another field would match', () => {
    const expectedSubject = 'CN=MANTU GROUP SA, O=MANTU GROUP SA, C=CH'
    const entry = 'CN=Someone Else, O=MANTU GROUP SA'
    const parsedEntry = parseDn(entry)
    const parsedSubject = parseDn(expectedSubject)
    expect([...parsedEntry.keys()].every((key) => parsedEntry.get(key) === parsedSubject.get(key))).toBe(false)

    const result = resolveWindowsSigningMode({
      ...BASE_AZURE_ENV, WIN_CSC_EXPECTED_SUBJECT: expectedSubject, WIN_UPDATE_PUBLISHER_NAMES: JSON.stringify([entry])
    })
    expect(result.code).toBe(SIGNING_MODE_CODES.PUBLISHER_LIST_EXCLUDES_SIGNER)
  })

  it('defaults the azure publisher list to [WIN_AZURE_PUBLISHER_NAME] when unset', () => {
    const result = resolveWindowsSigningMode(BASE_AZURE_ENV)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.updatePublisherNames).toEqual(['MANTU GROUP SA'])
  })

  it("leaves the pfx publisher list null when unset, so today's CN-derived pin applies unchanged", () => {
    const result = resolveWindowsSigningMode(BASE_PFX_ENV)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.updatePublisherNames).toBeNull()
  })

  it('accepts a transitional pfx list bridging the old CN=Mantu identity and the new one', () => {
    const result = resolveWindowsSigningMode({
      ...BASE_PFX_ENV, WIN_UPDATE_PUBLISHER_NAMES: JSON.stringify(['Mantu', 'MANTU GROUP SA'])
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.updatePublisherNames).toEqual(['Mantu', 'MANTU GROUP SA'])
  })

  it('rejects a transitional pfx list that has dropped the current signer', () => {
    const result = resolveWindowsSigningMode({
      ...BASE_PFX_ENV, WIN_UPDATE_PUBLISHER_NAMES: JSON.stringify(['SomeoneElse'])
    })
    expect(result.code).toBe(SIGNING_MODE_CODES.PUBLISHER_LIST_EXCLUDES_SIGNER)
  })

  it('never returns extra or missing keys on failure: only ok, code, variables', () => {
    const result = resolveWindowsSigningMode({})
    expect(Object.keys(result).sort()).toEqual(['code', 'ok', 'variables'])
  })

  it('never returns extra or missing keys on success: exactly ok, mode, expectedSubject, updatePublisherNames, azure', () => {
    expect(Object.keys(resolveWindowsSigningMode(BASE_PFX_ENV)).sort()).toEqual(
      ['azure', 'expectedSubject', 'mode', 'ok', 'updatePublisherNames'].sort()
    )
    expect(Object.keys(resolveWindowsSigningMode(BASE_AZURE_ENV)).sort()).toEqual(
      ['azure', 'expectedSubject', 'mode', 'ok', 'updatePublisherNames'].sort()
    )
  })
})

describe('describeSigningModeFailure', () => {
  it('always contains the fixed refusal phrase and the failing code, for every code in the enum', () => {
    for (const code of Object.values(SIGNING_MODE_CODES)) {
      const text = describeSigningModeFailure({ ok: false, code, variables: ['WIN_EXAMPLE_VAR'] })
      expect(text).toContain('refusing to publish an unsigned Windows release')
      expect(text).toContain(code)
    }
  })

  it('names the offending variables', () => {
    const text = describeSigningModeFailure({
      ok: false, code: SIGNING_MODE_CODES.PFX_INCOMPLETE, variables: ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']
    })
    expect(text).toContain('WIN_CSC_LINK')
    expect(text).toContain('WIN_CSC_KEY_PASSWORD')
  })

  it('never assumes a value field exists on the result: variables are the only per-failure detail', () => {
    const text = describeSigningModeFailure(resolveWindowsSigningMode({ GH_TOKEN: 'should-never-appear-in-output' }))
    expect(text).not.toContain('should-never-appear-in-output')
  })
})

describe('buildWindowsSigningOverlay', () => {
  it('requires an ok resolver result', () => {
    expect(() => buildWindowsSigningOverlay({ ok: false, code: 'X', variables: [] } as never, { baseConfigPath: '/abs/base.yml' }))
      .toThrow(/ok resolveWindowsSigningMode/)
  })

  it('requires baseConfigPath', () => {
    const resolved = resolveWindowsSigningMode(BASE_PFX_ENV)
    expect(() => buildWindowsSigningOverlay(resolved, {} as never)).toThrow(/baseConfigPath/)
  })

  it('builds the pfx overlay with an empty win block and no publish key when no transitional list is set', () => {
    const resolved = resolveWindowsSigningMode(BASE_PFX_ENV)
    const overlay = buildWindowsSigningOverlay(resolved, { baseConfigPath: '/abs/electron-builder.win.yml' })
    expect(overlay).toEqual({ extends: '/abs/electron-builder.win.yml', forceCodeSigning: true, win: {} })
  })

  it('builds the pfx overlay with publish.publisherName when a transitional list is set', () => {
    const resolved = resolveWindowsSigningMode({
      ...BASE_PFX_ENV, WIN_UPDATE_PUBLISHER_NAMES: JSON.stringify(['Mantu', 'MANTU GROUP SA'])
    })
    const overlay = buildWindowsSigningOverlay(resolved, { baseConfigPath: '/abs/electron-builder.win.yml' })
    expect(overlay).toEqual({
      extends: '/abs/electron-builder.win.yml',
      forceCodeSigning: true,
      win: {},
      publish: { publisherName: ['Mantu', 'MANTU GROUP SA'] }
    })
  })

  it('requires signHookPath in azure mode', () => {
    const resolved = resolveWindowsSigningMode(BASE_AZURE_ENV)
    expect(() => buildWindowsSigningOverlay(resolved, { baseConfigPath: '/abs/electron-builder.win.yml' }))
      .toThrow(/signHookPath/)
  })

  it('builds the azure overlay: win.signtoolOptions carries the sign hook, sha256-only hashing, and the publisher list; publish mirrors it', () => {
    const resolved = resolveWindowsSigningMode(BASE_AZURE_ENV)
    const overlay = buildWindowsSigningOverlay(resolved, {
      baseConfigPath: '/abs/electron-builder.win.yml',
      signHookPath: '/abs/scripts/azure-sign-hook.cjs'
    })
    expect(overlay).toEqual({
      extends: '/abs/electron-builder.win.yml',
      forceCodeSigning: true,
      win: {
        signtoolOptions: {
          sign: '/abs/scripts/azure-sign-hook.cjs',
          signingHashAlgorithms: ['sha256'],
          publisherName: ['MANTU GROUP SA']
        }
      },
      publish: { publisherName: ['MANTU GROUP SA'] }
    })
  })

  it('never includes Azure endpoint, account or certificate-profile identifiers: the hook reads those from env at sign time', () => {
    const resolved = resolveWindowsSigningMode(BASE_AZURE_ENV)
    const overlay = buildWindowsSigningOverlay(resolved, {
      baseConfigPath: '/abs/electron-builder.win.yml',
      signHookPath: '/abs/scripts/azure-sign-hook.cjs'
    })
    const serialized = JSON.stringify(overlay)
    expect(serialized).not.toContain('synthetic-account')
    expect(serialized).not.toContain('synthetic-profile')
    expect(serialized).not.toContain('codesigning.azure.net')
  })

  it('never mutates the resolver result it was given (defensive copies of the publisher list)', () => {
    const resolved = resolveWindowsSigningMode(BASE_AZURE_ENV)
    const before = JSON.stringify(resolved)
    const overlay = buildWindowsSigningOverlay(resolved, {
      baseConfigPath: '/abs/electron-builder.win.yml',
      signHookPath: '/abs/scripts/azure-sign-hook.cjs'
    })
    ;(overlay.win.signtoolOptions.publisherName as string[]).push('tampered')
    expect(JSON.stringify(resolved)).toBe(before)
  })
})

describe('check-release-secrets.mjs win: thin CLI over the resolver', () => {
  const cliPath = join(__dirname, 'check-release-secrets.mjs')

  function run(env: Env) {
    return spawnSync(process.execPath, [cliPath, 'win'], { encoding: 'utf8', env: env as NodeJS.ProcessEnv })
  }

  it('exits 0 and prints the resolved mode for a complete pfx configuration', () => {
    const result = run(BASE_PFX_ENV)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('[check:release-secrets] OK - win (pfx)')
    // Exactly one OK line: no leftover generic "OK - win" from the shared script footer.
    expect(result.stdout.trim().split('\n')).toHaveLength(1)
  })

  it('exits 0 and prints the resolved mode for a complete azure configuration', () => {
    const result = run(BASE_AZURE_ENV)
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('[check:release-secrets] OK - win (azure)')
  })

  it('exits 1 and names the fixed phrase and code when the mode is missing', () => {
    const result = run(without(BASE_PFX_ENV, 'WIN_SIGNING_MODE'))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('refusing to publish an unsigned Windows release')
    expect(result.stderr).toContain(SIGNING_MODE_CODES.REQUIRED)
    expect(result.stdout).toBe('')
  })

  it('exits 1 when both modes are configured at once (ambiguous)', () => {
    const result = run({ ...BASE_PFX_ENV, WIN_AZURE_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(SIGNING_MODE_CODES.AMBIGUOUS)
  })

  it('never echoes synthetic secret values to stdout or stderr on success', () => {
    const secretLink = 'ZzSuperSecretPfxBase64PayloadNeverPrinted=='
    const secretPassword = 'ZzSuperSecretPfxPasswordNeverPrinted'
    const result = run({ ...BASE_PFX_ENV, WIN_CSC_LINK: secretLink, WIN_CSC_KEY_PASSWORD: secretPassword })
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain(secretLink)
    expect(result.stdout).not.toContain(secretPassword)
    expect(result.stderr).not.toContain(secretLink)
    expect(result.stderr).not.toContain(secretPassword)
  })

  it('never echoes synthetic secret-shaped values to stdout or stderr on failure', () => {
    const secretEndpoint = 'ZzShouldNeverLeakThisEndpointValue'
    const secretAccount = 'ZzShouldNeverLeakThisAccountValue'
    const result = run({
      PATH: process.env.PATH || '', GH_TOKEN: 'synthetic', WIN_SIGNING_MODE: 'azure',
      WIN_AZURE_SIGNING_ENDPOINT: secretEndpoint, WIN_AZURE_SIGNING_ACCOUNT: secretAccount
    })
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain(secretEndpoint)
    expect(result.stdout).not.toContain(secretAccount)
    expect(result.stderr).not.toContain(secretEndpoint)
    expect(result.stderr).not.toContain(secretAccount)
    expect(result.stderr).toContain(SIGNING_MODE_CODES.AZURE_INCOMPLETE)
  })

  it('still gates macOS release secrets exactly as before (unaffected by the win-mode change)', () => {
    const result = spawnSync(process.execPath, [cliPath, 'mac'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH || '', GH_TOKEN: 'test-token' } as NodeJS.ProcessEnv
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('CSC_LINK')
    expect(result.stderr).toContain('APPLE_TEAM_ID')
  })
})
