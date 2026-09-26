'use strict'
// Custom electron-builder Windows sign hook (Lane C / L2-wrapper-hook — integration-design.md §2.3
// option B). Wired only through the overlay's win.signtoolOptions.sign (scripts/electron-builder-win.mjs);
// never through win.azureSignOptions, which would install electron-builder's own bundled — and
// unpinned — TrustedSigning module instead (see design §2.3, §F4, §F7).
//
// Calls the PINNED Microsoft "ArtifactSigning" PowerShell module's Invoke-ArtifactSigning cmdlet
// (module installed ahead of time by scripts/artifact-signing-module.mjs; this file never installs
// it and never talks to PSGallery). Reads only WIN_AZURE_SIGNING_ENDPOINT, WIN_AZURE_SIGNING_ACCOUNT,
// WIN_AZURE_CERT_PROFILE and ARTIFACT_SIGNING_MODULE_PATH from the environment — never an identity
// literal. Fails closed: any missing input, wrong platform, timeout or non-zero PowerShell exit is a
// fixed error code. Never logs an env value, a file's contents, or the child process's raw
// stdout/stderr, which can carry tenant/subscription identifiers or a partial DefaultAzureCredential
// probe error.
//
// module.exports is the `sign(configuration)` function app-builder-lib's WindowsSignToolManager calls
// per file/hash (node_modules/app-builder-lib/out/codeSign/windowsSignToolManager.js:114-167,
// customSign resolved at :132, executor invoked at :159-167): `executor({ path, options, name, site,
// cscInfo, hash, isNest, computeSignToolArgs }, packager)`. signingHashAlgorithms: ['sha256'] (set in
// the overlay) keeps that per-hash loop (:161) to one call per file instead of the sha1-then-sha256
// default (:118-125), and a null cscInfo (no PFX in azure mode) does not skip this hook — the "no
// signing info" skip only fires when BOTH cscInfo and customSign are absent (:155-157).
// Only `configuration.path` (the file to sign) is used here.
// module.exports.signWithArtifactSigning is the same signing call, reusable by
// scripts/windows-signing-azure-probe.mjs to sign one throwaway canary file with identical policy.

const { spawnSync } = require('node:child_process')

const TIMEOUT_MS = 5 * 60 * 1000 // Invoke-ArtifactSigning's own default -Timeout is 300s (per file batch)
// Generous, not tiny: every Write-Information call inside the pinned module passes its own
// `-InformationAction Continue` (ArtifactSigning.psm1), which overrides any $InformationPreference this
// script could set — so its per-file, per-dependency-check chatter cannot be quieted from here, and a
// tight buffer would turn a successful sign into a spurious ENOBUFS failure. Output is still bounded,
// and — successful or not — its contents are never logged (see the header comment).
const MAX_OUTPUT_BYTES = 1_048_576
const TIMESTAMP_URL = 'http://timestamp.acs.microsoft.com'
const PWSH_PROBE_TIMEOUT_MS = 15_000

const REQUIRED_ENV = {
  endpoint: 'WIN_AZURE_SIGNING_ENDPOINT',
  account: 'WIN_AZURE_SIGNING_ACCOUNT',
  certificateProfile: 'WIN_AZURE_CERT_PROFILE',
  modulePath: 'ARTIFACT_SIGNING_MODULE_PATH'
}

// Only PATH/shell/module-location plumbing — deliberately excludes every AZURE_* variable.
// windows-signing-mode.mjs already refuses the whole build if any AZURE_* credential env is present
// (AZURE_ENV_FORBIDDEN); this is defense in depth so a stray one is never forwarded to the child even
// if that gate were ever bypassed.
const PASSTHROUGH_ENV_NAMES = [
  'PATH', 'Path', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA',
  'APPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'HOMEDRIVE', 'HOMEPATH'
]

function requireEnv(name, env) {
  const value = env[name]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`AZURE_SIGN_HOOK_ENV_MISSING:${name}`)
  }
  return value.trim()
}

function selectedEnvironment(env) {
  const selected = {}
  for (const name of PASSTHROUGH_ENV_NAMES) {
    if (typeof env[name] === 'string') selected[name] = env[name]
  }
  // Import-Module below always takes an absolute .psd1 path, so PSModulePath never decides which
  // module loads — reset it the same way the rest of this repo's Windows PowerShell probes do
  // (scripts/lib/signing-policy.mjs windowsSignatureCommand), in case an inherited runner value
  // makes an unrelated cmdlet the nested submodules call fail to autoload.
  selected.PSModulePath = (selected.SystemRoot || 'C:\\Windows') + '\\System32\\WindowsPowerShell\\v1.0\\Modules'
  return selected
}

function quoteSingle(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

// Same shell electron-builder itself picks for every other Windows signing path: prefer PowerShell 7,
// fall back to Windows PowerShell 5.1. node_modules/app-builder-lib/out/vm/vm.js:11-21 does this by
// running `Get-Command pwsh.exe` through powershell.exe and catching a failure; probing pwsh.exe
// directly is equivalent and one process shorter.
function resolvePowerShell(spawnImpl, env = process.env) {
  const probe = spawnImpl('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
    timeout: PWSH_PROBE_TIMEOUT_MS, stdio: 'ignore', shell: false, windowsHide: true,
    env: selectedEnvironment(env)
  })
  return !probe.error && probe.status === 0 ? 'pwsh.exe' : 'powershell.exe'
}

// Invoke-ArtifactSigning's full mandatory/optional parameter set is documented in the pinned module's
// ArtifactSigning.psm1 (see scripts/artifact-signing-module.mjs). Excluding every credential source
// but AzureCliCredential means the only identity this can ever sign with is the one the workflow's
// `azure/login` (OIDC) step left behind as an az CLI session — never a managed identity, a shared
// token cache, an interactive browser prompt, or anything picked up from this process's own env.
function buildSigningScript({ endpoint, account, certificateProfile, modulePath, filePath }) {
  const params = [
    `-Endpoint ${quoteSingle(endpoint)}`,
    `-CodeSigningAccountName ${quoteSingle(account)}`,
    `-CertificateProfileName ${quoteSingle(certificateProfile)}`,
    `-Files ${quoteSingle(filePath)}`,
    '-FileDigest SHA256',
    `-TimestampRfc3161 ${quoteSingle(TIMESTAMP_URL)}`,
    '-TimestampDigest SHA256',
    '-ExcludeEnvironmentCredential',
    '-ExcludeWorkloadIdentityCredential',
    '-ExcludeManagedIdentityCredential',
    '-ExcludeSharedTokenCacheCredential',
    '-ExcludeVisualStudioCredential',
    '-ExcludeVisualStudioCodeCredential',
    '-ExcludeAzurePowerShellCredential',
    '-ExcludeAzureDeveloperCliCredential',
    '-ExcludeInteractiveBrowserCredential'
  ].join(' ')
  return [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    "$WarningPreference='SilentlyContinue'",
    `Import-Module ${quoteSingle(modulePath)} -Force -ErrorAction Stop`,
    `Invoke-ArtifactSigning ${params}`
  ].join('; ')
}

async function signWithArtifactSigning(filePath, {
  env = process.env,
  platform = process.platform,
  spawnImpl = spawnSync,
  timeoutMs = TIMEOUT_MS
} = {}) {
  if (platform !== 'win32') throw new Error('AZURE_SIGN_HOOK_UNSUPPORTED_PLATFORM')
  if (typeof filePath !== 'string' || !filePath) throw new Error('AZURE_SIGN_HOOK_NO_FILE')

  const endpoint = requireEnv(REQUIRED_ENV.endpoint, env)
  const account = requireEnv(REQUIRED_ENV.account, env)
  const certificateProfile = requireEnv(REQUIRED_ENV.certificateProfile, env)
  const modulePath = requireEnv(REQUIRED_ENV.modulePath, env)

  const shell = resolvePowerShell(spawnImpl, env)
  const script = buildSigningScript({ endpoint, account, certificateProfile, modulePath, filePath })
  const result = spawnImpl(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    env: selectedEnvironment(env)
  })

  if (result.error) {
    throw new Error(result.error.code === 'ETIMEDOUT' ? 'AZURE_SIGN_HOOK_TIMEOUT' : 'AZURE_SIGN_HOOK_SPAWN_FAILED')
  }
  if (result.status !== 0) {
    // Deliberately never forwards native stdout/stderr: DefaultAzureCredential's chain can print a
    // per-credential failure line that names the tenant, and a metadata.json parse error can echo path
    // fragments. A fixed code plus exit status is all a caller needs to diagnose from CI logs.
    throw new Error(`AZURE_SIGN_HOOK_FAILED:${typeof result.status === 'number' ? result.status : 'unknown'}`)
  }
  return true
}

module.exports = async function sign(configuration) {
  if (process.platform !== 'win32') throw new Error('AZURE_SIGN_HOOK_UNSUPPORTED_PLATFORM')
  if (!configuration || typeof configuration.path !== 'string' || !configuration.path) {
    throw new Error('AZURE_SIGN_HOOK_NO_FILE')
  }
  await signWithArtifactSigning(configuration.path)
  return true
}
module.exports.signWithArtifactSigning = signWithArtifactSigning
// Exposed for tests only (script construction, env selection, shell fallback probing).
module.exports.buildSigningScript = buildSigningScript
module.exports.selectedEnvironment = selectedEnvironment
module.exports.resolvePowerShell = resolvePowerShell
