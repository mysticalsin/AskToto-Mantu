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
    '[PSCustomObject]@{Status=[string]$s.Status;Subject=[string]$s.SignerCertificate.Subject;CommonName=[string]$cn;TimeStamperSubject=[string]$s.TimeStamperCertificate.Subject} | ConvertTo-Json -Compress'
  ].join('; ')
}

export function windowsSignatureProblem(signature, expectedSigner) {
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
  return null
}
