import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

export function selectSigningDirectory(argument, env = process.env, exists = existsSync) {
  // An explicitly requested build must never fall back to another (possibly stale) output.
  const explicit = argument || env.ASKTOTO_ARTIFACTS_DIR
  const candidates = explicit ? [explicit] : ['release', 'dist']
  return { directory: candidates.find((candidate) => exists(candidate)) || null, candidates }
}

export function assertSigningHost(host) {
  if (host !== 'darwin' && host !== 'win32') {
    throw new Error('Signature verification requires a macOS or Windows host; no artifacts were verified')
  }
}

export function windowsPowerShell(env = process.env) {
  return win32.join(
    env.SystemRoot || env.windir || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
  )
}

export function windowsSignatureCommand(executable) {
  const quoted = executable.replace(/'/g, "''")
  return [
    "$ErrorActionPreference='Stop'",
    // GitHub's pwsh runner exports its PowerShell 7 module path. Windows PowerShell 5 must load its
    // own Security module; inherited discovery failed with CouldNotAutoloadMatchingModule in v1.8.9.
    "$env:PSModulePath=$PSHOME+'\\Modules'",
    "Import-Module ($PSHOME+'\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop",
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    `$s=Get-AuthenticodeSignature -LiteralPath '${quoted}'`,
    "$cn=''; if ($s.SignerCertificate) { $cn=$s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) }",
    // Azure mode's EKU policy (windowsSignatureProblem below) needs the SIGNER's enhanced-key-usage
    // OIDs — same extension (2.5.29.37), same extraction technique as the identity preflight uses on
    // the signing certificate itself (windows-signing-identity-preflight.ps1:38-45). An array-valued
    // property survives ConvertTo-Json here because it is nested under the object, not the pipeline's
    // top-level input; only a *top-level* single-element array collapses to a scalar.
    "$ekuOids=@(); if ($s.SignerCertificate) { foreach ($ext in $s.SignerCertificate.Extensions) { if ($ext.Oid.Value -eq '2.5.29.37') { $eku=New-Object System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension; $eku.CopyFrom($ext); foreach ($u in $eku.EnhancedKeyUsages) { $ekuOids+=$u.Value } } } }",
    '[PSCustomObject]@{Status=[string]$s.Status;Subject=[string]$s.SignerCertificate.Subject;CommonName=[string]$cn;TimeStamperSubject=[string]$s.TimeStamperCertificate.Subject;EkuOids=$ekuOids} | ConvertTo-Json -Compress'
  ].join('; ')
}

// Microsoft Artifact Signing / Trusted Signing EKU OIDs (design §2.5, all VERIFIED against
// learn.microsoft.com/en-us/azure/artifact-signing/concept-certificate-management and
// concept-resources-roles, seen 2026-09-24). Public Trust is the marker every azure-mode signature
// must carry; the lifetime-signing EKU marks a Public Trust *Test* certificate, whose signature expires
// with its 3-day certificate even when timestamped, so it must never reach a public release.
const AZURE_PUBLIC_TRUST_EKU = '1.3.6.1.4.1.311.97.1.0'
const AZURE_LIFETIME_SIGNING_EKU = '1.3.6.1.4.1.311.10.3.13'

export function windowsSignatureProblem(signature, expectedSigner, policy = { mode: 'pfx' }) {
  const expected = String(expectedSigner || '').trim()
  const status = String(signature?.Status || '')
  const subject = String(signature?.Subject || '').trim()
  const commonName = String(signature?.CommonName || '').trim()
  if (!expected) return 'WIN_CSC_EXPECTED_SUBJECT is required'
  if (!/^Valid$/i.test(status)) return `Authenticode ${status || 'UNSIGNED'}`
  if (subject !== expected && commonName !== expected) {
    return 'Authenticode signer does not exactly match WIN_CSC_EXPECTED_SUBJECT'
  }
  // A valid signature without a trusted timestamp stops validating when its signing certificate
  // expires. Get-AuthenticodeSignature validates the chain; require that timestamp to be present too.
  if (!String(signature?.TimeStamperSubject || '').trim()) {
    return 'Authenticode signature is missing its trusted timestamp'
  }
  // PFX mode: unchanged from today. Only azure mode carries an EKU policy (design §2.3/§2.5) — the
  // self-signed CN=Mantu PFX has no Public Trust EKU at all, so this must never apply to it.
  if (policy?.mode === 'azure') {
    const ekuOids = Array.isArray(signature?.EkuOids) ? signature.EkuOids.map((oid) => String(oid).trim()) : null
    // Fail closed: a missing or malformed EKU list is as untrustworthy as a wrong one.
    if (!ekuOids) return 'Authenticode signature is missing its enhanced key usage (EKU) list'
    if (ekuOids.includes(AZURE_LIFETIME_SIGNING_EKU)) {
      return 'Authenticode signature carries the lifetime-signing EKU of a Public Trust Test certificate; refusing to publish a release that expires with its 3-day certificate'
    }
    if (!ekuOids.includes(AZURE_PUBLIC_TRUST_EKU)) {
      return `Authenticode signature is missing the Public Trust EKU ${AZURE_PUBLIC_TRUST_EKU}`
    }
    const identityEku = String(policy.identityEku || '').trim()
    if (identityEku && !ekuOids.includes(identityEku)) {
      return `Authenticode signature is missing the configured identity EKU ${identityEku}`
    }
  }
  return null
}
