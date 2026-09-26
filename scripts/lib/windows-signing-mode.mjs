// Fail-closed Windows signing-mode resolver, shared by check-release-secrets.mjs (win mode) and
// scripts/electron-builder-win.mjs. Pure functions over `env`: no filesystem, no network, no child
// process. ESM, dependency-free (Node builtins only) so it can be imported by both a plain CLI and
// the release wrapper without pulling in electron-builder's own module graph.
//
// Every failure returns one fixed code plus the NAMES of the variables involved, never their values.
// windows-signing-mode.test.ts drives the exhaustive matrix; this file only encodes the rules.

export const WINDOWS_SIGNING_MODES = ['pfx', 'azure']

export const SIGNING_MODE_CODES = {
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
}

const AZURE_ENDPOINT_PATTERN = /^https:\/\/[a-z0-9]+\.codesigning\.azure\.net\/?$/
const AZURE_IDENTITY_EKU_PATTERN = /^1\.3\.6\.1\.4\.1\.311\.97\.[0-9.]+$/

// The bare fallback electron-builder reads when no WIN_-prefixed identity is set
// (app-builder-lib platformPackager.js resolves CSC_LINK/CSC_KEY_PASSWORD for every platform).
// Forbidden in every mode: a stray personal secret must never silently sign a public release
// outside this resolver's view.
const CSC_FALLBACK_VARS = ['CSC_LINK', 'CSC_KEY_PASSWORD']

// OIDC via azure/login needs none of these. Forbidden in the build step's own env in EVERY mode:
// the packaged-launch gate hands the app's whole build env to the running app, which reads
// AZURE_CLIENT_ID / AZURE_TENANT_ID as its own SSO config (src/main/auth.ts), and a stray one of
// these would also change which DefaultAzureCredential wins during signing.
const FORBIDDEN_AZURE_ENV_VARS = [
  'AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_CERTIFICATE_PATH', 'AZURE_FEDERATED_TOKEN_FILE',
  'AZURE_USERNAME', 'AZURE_PASSWORD'
]

const PFX_REQUIRED_VARS = ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'WIN_CSC_EXPECTED_SUBJECT']
const AZURE_REQUIRED_VARS = [
  'WIN_AZURE_SIGNING_ENDPOINT', 'WIN_AZURE_SIGNING_ACCOUNT',
  'WIN_AZURE_CERT_PROFILE', 'WIN_AZURE_PUBLISHER_NAME', 'WIN_CSC_EXPECTED_SUBJECT'
]
// Mode-exclusive vars used only to detect the other mode's inputs leaking in. WIN_CSC_EXPECTED_SUBJECT
// is shared by both modes and is deliberately excluded from both lists below.
const PFX_ONLY_VARS = ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']
const AZURE_ONLY_VARS = [
  'WIN_AZURE_SIGNING_ENDPOINT', 'WIN_AZURE_SIGNING_ACCOUNT',
  'WIN_AZURE_CERT_PROFILE', 'WIN_AZURE_PUBLISHER_NAME', 'WIN_AZURE_IDENTITY_EKU'
]

function value(env, name) {
  return String(env[name] ?? '').trim()
}

function present(env, name) {
  return value(env, name).length > 0
}

function fail(code, variables) {
  return { ok: false, code, variables: [...variables] }
}

// In-repo port of builder-util-runtime's rfc2253Parser.parseDn
// (node_modules/builder-util-runtime/out/rfc2253Parser.js), kept here so this module stays
// dependency-free. windows-signing-mode.test.ts cross-checks this against the installed package
// (resolved from electron-updater's own dependency tree) so the two can never silently drift.
function parseDn(seq) {
  let quoted = false
  let key = null
  let token = ''
  let nextNonSpace = 0
  seq = seq.trim()
  const result = new Map()
  for (let i = 0; i <= seq.length; i++) {
    if (i === seq.length) {
      if (key !== null) result.set(key, token)
      break
    }
    const ch = seq[i]
    if (quoted) {
      if (ch === '"') { quoted = false; continue }
    } else {
      if (ch === '"') { quoted = true; continue }
      if (ch === '\\') {
        i++
        const ord = parseInt(seq.slice(i, i + 2), 16)
        if (Number.isNaN(ord)) token += seq[i]
        else { i++; token += String.fromCharCode(ord) }
        continue
      }
      if (key === null && ch === '=') { key = token; token = ''; continue }
      if (ch === ',' || ch === ';' || ch === '+') {
        if (key !== null) result.set(key, token)
        key = null
        token = ''
        continue
      }
    }
    if (ch === ' ' && !quoted) {
      if (token.length === 0) continue
      if (i > nextNonSpace) {
        let j = i
        while (seq[j] === ' ') j++
        nextNonSpace = j
      }
      if (nextNonSpace >= seq.length || seq[nextNonSpace] === ',' || seq[nextNonSpace] === ';' ||
          (key === null && seq[nextNonSpace] === '=') || (key !== null && seq[nextNonSpace] === '+')) {
        i = nextNonSpace - 1
        continue
      }
    }
    token += ch
  }
  return result
}

// Mirrors electron-updater's own match loop
// (electron-updater/out/windowsExecutableCodeSignatureVerifier.js:70-89): an entry containing '='
// is parsed as a DN and every key it names must equal the signer's value (subset compare); a plain
// entry is compared to the signer's CN only. `expectedSubject` stands in here for the certificate
// that will sign this release (WIN_CSC_EXPECTED_SUBJECT), the same way `data.SignerCertificate.Subject`
// does at verify time.
function publisherEntryMatchesExpectedSubject(entry, expectedSubject) {
  const entryDn = parseDn(entry)
  if (entryDn.size) {
    const subjectDn = expectedSubject.includes('=') ? parseDn(expectedSubject) : new Map([['CN', expectedSubject]])
    return [...entryDn.keys()].every((key) => entryDn.get(key) === subjectDn.get(key))
  }
  const expectedCn = expectedSubject.includes('=') ? parseDn(expectedSubject).get('CN') : expectedSubject
  return expectedCn !== undefined && entry === expectedCn
}

function parsePublisherList(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  if (!parsed.every((entry) => typeof entry === 'string' && entry.trim().length > 0)) return null
  return parsed
}

/**
 * Resolves which Windows signing mode a release build should use, or a fixed failure code.
 *
 * Checks run in a fixed priority order so exactly one code is ever returned for a given env:
 * GH token -> mode set/valid -> global forbidden vars -> mode ambiguity -> mode completeness ->
 * azure endpoint/EKU format -> update-publisher-name list.
 */
export function resolveWindowsSigningMode(env = process.env) {
  if (!present(env, 'GH_TOKEN') && !present(env, 'GITHUB_TOKEN')) {
    return fail(SIGNING_MODE_CODES.GH_TOKEN_MISSING, ['GH_TOKEN', 'GITHUB_TOKEN'])
  }

  const mode = value(env, 'WIN_SIGNING_MODE')
  if (!mode) return fail(SIGNING_MODE_CODES.REQUIRED, ['WIN_SIGNING_MODE'])
  if (!WINDOWS_SIGNING_MODES.includes(mode)) return fail(SIGNING_MODE_CODES.INVALID, ['WIN_SIGNING_MODE'])

  const cscFallback = CSC_FALLBACK_VARS.filter((name) => present(env, name))
  if (cscFallback.length) return fail(SIGNING_MODE_CODES.CSC_FALLBACK_FORBIDDEN, cscFallback)

  const forbiddenAzure = FORBIDDEN_AZURE_ENV_VARS.filter((name) => present(env, name))
  if (forbiddenAzure.length) return fail(SIGNING_MODE_CODES.AZURE_ENV_FORBIDDEN, forbiddenAzure)

  if (mode === 'pfx') {
    const ambiguous = AZURE_ONLY_VARS.filter((name) => present(env, name))
    if (ambiguous.length) return fail(SIGNING_MODE_CODES.AMBIGUOUS, ambiguous)
    const missing = PFX_REQUIRED_VARS.filter((name) => !present(env, name))
    if (missing.length) return fail(SIGNING_MODE_CODES.PFX_INCOMPLETE, missing)
  } else {
    const ambiguous = PFX_ONLY_VARS.filter((name) => present(env, name))
    if (ambiguous.length) return fail(SIGNING_MODE_CODES.AMBIGUOUS, ambiguous)
    const missing = AZURE_REQUIRED_VARS.filter((name) => !present(env, name))
    if (missing.length) return fail(SIGNING_MODE_CODES.AZURE_INCOMPLETE, missing)
    if (!AZURE_ENDPOINT_PATTERN.test(value(env, 'WIN_AZURE_SIGNING_ENDPOINT'))) {
      return fail(SIGNING_MODE_CODES.ENDPOINT_INVALID, ['WIN_AZURE_SIGNING_ENDPOINT'])
    }
    if (present(env, 'WIN_AZURE_IDENTITY_EKU') &&
        !AZURE_IDENTITY_EKU_PATTERN.test(value(env, 'WIN_AZURE_IDENTITY_EKU'))) {
      // No dedicated code for a malformed (as opposed to missing) optional EKU: it is still Azure
      // configuration that is not usable as given.
      return fail(SIGNING_MODE_CODES.AZURE_INCOMPLETE, ['WIN_AZURE_IDENTITY_EKU'])
    }
  }

  const expectedSubject = value(env, 'WIN_CSC_EXPECTED_SUBJECT')
  let updatePublisherNames = null
  if (present(env, 'WIN_UPDATE_PUBLISHER_NAMES')) {
    const parsed = parsePublisherList(value(env, 'WIN_UPDATE_PUBLISHER_NAMES'))
    if (!parsed) return fail(SIGNING_MODE_CODES.PUBLISHER_LIST_INVALID, ['WIN_UPDATE_PUBLISHER_NAMES'])
    updatePublisherNames = parsed
  } else if (mode === 'azure') {
    updatePublisherNames = [value(env, 'WIN_AZURE_PUBLISHER_NAME')]
  }

  if (updatePublisherNames &&
      !updatePublisherNames.some((entry) => publisherEntryMatchesExpectedSubject(entry, expectedSubject))) {
    return fail(SIGNING_MODE_CODES.PUBLISHER_LIST_EXCLUDES_SIGNER,
      ['WIN_UPDATE_PUBLISHER_NAMES', 'WIN_CSC_EXPECTED_SUBJECT'])
  }

  if (mode === 'pfx') {
    return { ok: true, mode: 'pfx', expectedSubject, updatePublisherNames, azure: null }
  }
  return {
    ok: true,
    mode: 'azure',
    expectedSubject,
    updatePublisherNames,
    azure: {
      endpoint: value(env, 'WIN_AZURE_SIGNING_ENDPOINT'),
      account: value(env, 'WIN_AZURE_SIGNING_ACCOUNT'),
      certificateProfile: value(env, 'WIN_AZURE_CERT_PROFILE'),
      publisherName: value(env, 'WIN_AZURE_PUBLISHER_NAME'),
      identityEku: present(env, 'WIN_AZURE_IDENTITY_EKU') ? value(env, 'WIN_AZURE_IDENTITY_EKU') : null
    }
  }
}

const FAILURE_REASONS = {
  [SIGNING_MODE_CODES.GH_TOKEN_MISSING]: 'no GitHub release token is set',
  [SIGNING_MODE_CODES.REQUIRED]: 'the signing mode is not set',
  [SIGNING_MODE_CODES.INVALID]: `the signing mode must be one of: ${WINDOWS_SIGNING_MODES.join(', ')}`,
  [SIGNING_MODE_CODES.CSC_FALLBACK_FORBIDDEN]: 'the generic CSC fallback is forbidden in this job',
  [SIGNING_MODE_CODES.AZURE_ENV_FORBIDDEN]: 'forbidden Azure credential variables are present in the build env',
  [SIGNING_MODE_CODES.AMBIGUOUS]: 'inputs for both signing modes are present at once',
  [SIGNING_MODE_CODES.PFX_INCOMPLETE]: 'PFX mode is missing required configuration',
  [SIGNING_MODE_CODES.AZURE_INCOMPLETE]: 'Azure mode configuration is missing or invalid',
  [SIGNING_MODE_CODES.ENDPOINT_INVALID]: 'the Azure Artifact Signing endpoint is not a valid *.codesigning.azure.net URL',
  [SIGNING_MODE_CODES.PUBLISHER_LIST_INVALID]: 'the update publisher name list is not a JSON array of non-empty strings',
  [SIGNING_MODE_CODES.PUBLISHER_LIST_EXCLUDES_SIGNER]:
    'the update publisher name list would reject the identity that is about to sign this release'
}

/** Human failure text. Names variables only, never their values. Always carries the fixed refusal phrase. */
export function describeSigningModeFailure(result) {
  const reason = FAILURE_REASONS[result?.code] || result?.code || 'unknown signing mode failure'
  const variables = Array.isArray(result?.variables) ? result.variables : []
  const named = variables.length ? ` (${variables.join(', ')})` : ''
  return `refusing to publish an unsigned Windows release: ${reason}${named} [${result?.code}]`
}

/**
 * Builds the electron-builder config overlay for an `ok` resolveWindowsSigningMode() result.
 * Never includes secrets or credentials: azure mode carries only the sign-hook path and the
 * (non-secret) publisher name list; the hook itself reads endpoint/account/profile from env at
 * sign time.
 */
export function buildWindowsSigningOverlay(resolved, { baseConfigPath, signHookPath } = {}) {
  if (!resolved || resolved.ok !== true) {
    throw new Error('buildWindowsSigningOverlay requires an ok resolveWindowsSigningMode() result')
  }
  if (!baseConfigPath) throw new Error('buildWindowsSigningOverlay requires baseConfigPath')

  const overlay = { extends: baseConfigPath, forceCodeSigning: true, win: {} }

  if (resolved.mode === 'azure') {
    if (!signHookPath) throw new Error('buildWindowsSigningOverlay requires signHookPath in azure mode')
    const publisherName = [...resolved.updatePublisherNames]
    overlay.win.signtoolOptions = { sign: signHookPath, signingHashAlgorithms: ['sha256'], publisherName }
    overlay.publish = { publisherName }
  } else if (resolved.updatePublisherNames) {
    overlay.publish = { publisherName: [...resolved.updatePublisherNames] }
  }

  return overlay
}
