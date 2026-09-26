#!/usr/bin/env node
// Azure Artifact Signing canary probe (design §4, §2.6). Signs ONE throwaway PE with the exact
// signing path the release build will use, then verifies it against the shared azure Public Trust
// EKU policy — all before the ~60+ minute app build starts. Never builds, signs or publishes Metis
// itself; the canary carries no app code.
//
// Two modes, mirroring windows-signing-identity-preflight.mjs:
//   node scripts/windows-signing-azure-probe.mjs                 (manual: reused by the standalone
//                                                                  workflow_dispatch preflight)
//   node scripts/windows-signing-azure-probe.mjs --release-gate  (release.yml, azure mode only)
// Each mode requires its own GitHub Actions trigger context and rejects the other's (design §2.6).
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { windowsPowerShell, windowsSignatureCommand, windowsSignatureProblem } from './lib/signing-policy.mjs'
import { checkTrustedRevision, checkReleaseRevision } from './windows-signing-identity-preflight.mjs'

const MAX_PROBE_BYTES = 4_096
const COMPILE_TIMEOUT_MS = 30_000
const SIGN_TIMEOUT_MS = 6 * 60_000 // azure-sign-hook's own Invoke-ArtifactSigning timeout is 5 min; give it room to report back
const VERIFY_TIMEOUT_MS = 30_000

function result(code, revision = 'unknown') {
  return { ok: code === 'PASS', code, revision }
}

function selectedEnvironment(env, names) {
  return Object.fromEntries(names.filter((name) => typeof env[name] === 'string').map((name) => [name, env[name]]))
}

// scripts/lib/signing-policy.mjs's windowsSignatureProblem already returns a fixed set of human
// sentences (never raw native text) for both the pre-existing PFX checks and the azure EKU policy
// (design §2.5). Turning them into a fixed code is the same technique scripts/sign-win.mjs already
// uses for its own policyFailureCategories map; this adds the AUTHENTICODE_<Status> family and the
// azure-only EKU categories this probe's fixed output-code contract requires (design §4).
function classifySignatureProblem(problem) {
  if (!problem) return null
  if (problem === 'Authenticode signature is missing its trusted timestamp') return 'TIMESTAMP_MISSING'
  if (problem === 'Authenticode signer does not exactly match WIN_CSC_EXPECTED_SUBJECT') return 'PUBLISHER_MISMATCH'
  if (problem === 'Authenticode signature is missing its enhanced key usage (EKU) list') return 'PUBLIC_TRUST_EKU_MISSING'
  if (problem.startsWith('Authenticode signature is missing the Public Trust EKU ')) return 'PUBLIC_TRUST_EKU_MISSING'
  if (problem.startsWith('Authenticode signature carries the lifetime-signing EKU')) return 'TEST_PROFILE_EKU_PRESENT'
  if (problem.startsWith('Authenticode signature is missing the configured identity EKU ')) return 'IDENTITY_EKU_MISMATCH'
  const status = /^Authenticode ([A-Za-z0-9_]{1,40})$/.exec(problem)?.[1]
  return status ? `AUTHENTICODE_${status}` : 'PUBLISHER_MISMATCH'
}

// Never anything but an empty-namespace marker type: this PE carries no app code and is discarded
// after the probe. Confined to the caller's tempDir (RUNNER_TEMP in CI).
export function compileCanaryAssembly(path, probe = spawnSync) {
  const quoted = path.replace(/'/g, "''")
  const command = [
    "$ErrorActionPreference='Stop'", "$ProgressPreference='SilentlyContinue'",
    `Add-Type -OutputType Library -OutputAssembly '${quoted}' -TypeDefinition 'namespace MetisSigningCanary { public class Marker {} }'`
  ].join('; ')
  const child = probe(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', timeout: COMPILE_TIMEOUT_MS, maxBuffer: MAX_PROBE_BYTES,
    killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
    env: selectedEnvironment(process.env, ['SystemRoot', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'PATH', 'Path'])
  })
  return !child?.error && child?.status === 0
}

// Lazily loaded: scripts/azure-sign-hook.cjs is a sibling lane's deliverable and must not be required
// at module load time, or every dependency-free test of this file would need it to exist on disk.
function defaultSignWithArtifactSigning(path) {
  let hook
  try {
    hook = createRequire(import.meta.url)('./azure-sign-hook.cjs')
  } catch {
    return Promise.reject(new Error('AZURE_SIGN_HOOK_UNAVAILABLE'))
  }
  if (typeof hook?.signWithArtifactSigning !== 'function') return Promise.reject(new Error('AZURE_SIGN_HOOK_INVALID'))
  return hook.signWithArtifactSigning(path)
}

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('PROBE_TIMEOUT'), { code: 'PROBE_TIMEOUT' })), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export async function runAzureSigningProbe({
  env = process.env, platform = process.platform, mode = 'manual',
  revisionCommand = execFileSync, compile = compileCanaryAssembly, exists = existsSync,
  sign = defaultSignWithArtifactSigning, probe = spawnSync, tempDir, cleanup = true,
  signTimeoutMs = SIGN_TIMEOUT_MS
} = {}) {
  if (platform !== 'win32') return result('UNSUPPORTED_PLATFORM')
  const revisionCheck = mode === 'release-gate' ? checkReleaseRevision : mode === 'manual' ? checkTrustedRevision : null
  if (!revisionCheck) return result('ARGUMENTS_UNSUPPORTED')
  const revision = revisionCheck(env, revisionCommand)
  if (!revision.ok) return revision
  const fail = (code) => result(code, revision.revision)

  const expectedSubject = String(env.WIN_CSC_EXPECTED_SUBJECT || '').trim()
  const identityEku = String(env.WIN_AZURE_IDENTITY_EKU || '').trim() || null
  if (!expectedSubject || !String(env.WIN_AZURE_SIGNING_ENDPOINT || '').trim() ||
      !String(env.WIN_AZURE_SIGNING_ACCOUNT || '').trim() || !String(env.WIN_AZURE_CERT_PROFILE || '').trim()) {
    return fail('AZURE_CONFIG_INCOMPLETE')
  }

  const directory = tempDir || env.RUNNER_TEMP || tmpdir()
  const canaryPath = join(directory, `metis-canary-${process.pid}-${randomBytes(4).toString('hex')}.dll`)
  let built = false
  try { built = compile(canaryPath) } catch { built = false }
  if (!built || !exists(canaryPath)) return fail('CANARY_BUILD_FAILED')

  try {
    await withTimeout(Promise.resolve().then(() => sign(canaryPath)), signTimeoutMs)
  } catch (error) {
    return fail(error?.code === 'PROBE_TIMEOUT' ? 'PROBE_TIMEOUT' : 'AZURE_SIGN_FAILED')
  } finally {
    if (cleanup) { try { rmSync(canaryPath, { force: true }) } catch { /* best effort */ } }
  }

  // Reuse the exact PFX-path verification command/policy (design §2.5): one Get-AuthenticodeSignature
  // call, the same fixed JSON shape verify-signing.mjs and sign-win.mjs already parse, and the azure
  // EKU policy branch scripts/lib/signing-policy.mjs's windowsSignatureProblem already implements.
  let child
  try {
    child = probe(windowsPowerShell(env), ['-NoProfile', '-NonInteractive', '-Command', windowsSignatureCommand(canaryPath)], {
      encoding: 'utf8', timeout: VERIFY_TIMEOUT_MS, maxBuffer: MAX_PROBE_BYTES,
      killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
      env: selectedEnvironment(env, ['SystemRoot', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA'])
    })
  } catch {
    return fail('PROBE_EXECUTION_FAILED')
  }
  if (child?.error) return fail(child.error.code === 'ETIMEDOUT' ? 'PROBE_TIMEOUT' :
    child.error.code === 'ENOBUFS' ? 'PROBE_OUTPUT_LIMIT' : 'PROBE_EXECUTION_FAILED')
  const text = typeof child?.stdout === 'string' ? child.stdout.trim() : ''
  const bounded = typeof child?.stdout === 'string' && Buffer.byteLength(child.stdout) <= MAX_PROBE_BYTES
  if (child?.status !== 0 || !bounded || child.stderr || !text) return fail('PROBE_EXECUTION_FAILED')
  let signature
  try {
    signature = JSON.parse(text)
  } catch {
    return fail('PROBE_OUTPUT_INVALID')
  }
  const problem = windowsSignatureProblem(signature, expectedSubject, { mode: 'azure', identityEku })
  return fail(problem ? classifySignatureProblem(problem) : 'PASS')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv.length === 2 ? 'manual'
    : process.argv.length === 3 && process.argv[2] === '--release-gate' ? 'release-gate' : null
  if (!mode) {
    console.log(JSON.stringify(result('ARGUMENTS_UNSUPPORTED')))
    process.exitCode = 1
  } else {
    runAzureSigningProbe({ mode }).then((outcome) => {
      console.log(JSON.stringify(outcome))
      process.exitCode = outcome.ok ? 0 : 1
    }).catch(() => {
      console.log(JSON.stringify(result('PROBE_INTERNAL_FAILED')))
      process.exitCode = 1
    })
  }
}
