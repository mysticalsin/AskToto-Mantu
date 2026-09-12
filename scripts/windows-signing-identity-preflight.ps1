# Invoked only through the bounded, fixed-output Node supervisor. No identity files or stores.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
$env:PSModulePath = $PSHOME + '\Modules'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Get-IdentityFacts {
    param(
        [System.Security.Cryptography.X509Certificates.X509Certificate2Collection] $Certificates,
        [string] $Expected
    )
    $facts = [ordered]@{
        version = 1; privateKeyCount = 0; subjectMatches = $false
        notBeforeMs = $null; notAfterMs = $null; codeSigningEku = $false
        digitalSignatureUsage = $true; privateKeyAvailable = $false; chain = 'untrusted'
    }
    $identity = $null
    foreach ($certificate in $Certificates) {
        if ($certificate.HasPrivateKey) { $facts.privateKeyCount++; $identity = $certificate }
    }
    if ($facts.privateKeyCount -ne 1) { return [PSCustomObject]$facts }

    $expectedName = $Expected.Trim()
    $commonName = $identity.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    $facts.subjectMatches = [string]::Equals($identity.Subject.Trim(), $expectedName, [StringComparison]::Ordinal) -or
        [string]::Equals($commonName.Trim(), $expectedName, [StringComparison]::Ordinal)
    $facts.notBeforeMs = ([DateTimeOffset]($identity.NotBefore.ToUniversalTime())).ToUnixTimeMilliseconds()
    $facts.notAfterMs = ([DateTimeOffset]($identity.NotAfter.ToUniversalTime())).ToUnixTimeMilliseconds()
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if (!$facts.subjectMatches -or $facts.notBeforeMs -gt $now -or $facts.notAfterMs -lt $now) {
        return [PSCustomObject]$facts
    }

    foreach ($extension in $identity.Extensions) {
        if ($extension.Oid.Value -eq '2.5.29.37') {
            $eku = New-Object System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension
            $eku.CopyFrom($extension)
            foreach ($usage in $eku.EnhancedKeyUsages) {
                if ($usage.Value -eq '1.3.6.1.5.5.7.3.3') { $facts.codeSigningEku = $true }
            }
        }
        if ($extension.Oid.Value -eq '2.5.29.15') {
            $keyUsage = New-Object System.Security.Cryptography.X509Certificates.X509KeyUsageExtension
            $keyUsage.CopyFrom($extension)
            $facts.digitalSignatureUsage = ($keyUsage.KeyUsages -band
                [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature) -ne 0
        }
    }
    if (!$facts.codeSigningEku -or !$facts.digitalSignatureUsage) { return [PSCustomObject]$facts }

    # Acquiring and inspecting the handle is the limit: never sign a challenge or export the key.
    $key = $null
    try {
        $key = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($identity)
        if ($null -eq $key) {
            $key = [System.Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPrivateKey($identity)
        }
        $facts.privateKeyAvailable = $null -ne $key -and $key.KeySize -gt 0
    } catch { $facts.privateKeyAvailable = $false }
    finally { if ($null -ne $key) { try { $key.Dispose() } catch {} } }
    if (!$facts.privateKeyAvailable) { return [PSCustomObject]$facts }

    $chain = $null
    try {
        $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
        $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::Online
        $chain.ChainPolicy.RevocationFlag = [System.Security.Cryptography.X509Certificates.X509RevocationFlag]::ExcludeRoot
        $chain.ChainPolicy.VerificationFlags = [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::NoFlag
        $chain.ChainPolicy.VerificationTime = [DateTime]::Now
        $chain.ChainPolicy.UrlRetrievalTimeout = [TimeSpan]::FromSeconds(10)
        # Newer managed runtimes expose this property; Windows PowerShell 5 may not. Standard
        # Windows chain/root maintenance and revocation caches on this disposable runner remain.
        if ($null -ne $chain.ChainPolicy.PSObject.Properties['DisableCertificateDownloads']) {
            $chain.ChainPolicy.DisableCertificateDownloads = $true
        }
        [void]$chain.ChainPolicy.ApplicationPolicy.Add((New-Object System.Security.Cryptography.Oid('1.3.6.1.5.5.7.3.3')))
        # These certificates are untrusted chain-building material only, never custom trust roots.
        $chain.ChainPolicy.ExtraStore.AddRange($Certificates)
        $trusted = $chain.Build($identity)
        $statuses = $chain.ChainStatus
        if ($trusted -and $statuses.Length -eq 0) { $facts.chain = 'trusted' }
        else {
            $revoked = $false; $unavailable = $false
            foreach ($status in $statuses) {
                if (($status.Status -band [System.Security.Cryptography.X509Certificates.X509ChainStatusFlags]::Revoked) -ne 0) { $revoked = $true }
                if (($status.Status -band ([System.Security.Cryptography.X509Certificates.X509ChainStatusFlags]::RevocationStatusUnknown -bor
                    [System.Security.Cryptography.X509Certificates.X509ChainStatusFlags]::OfflineRevocation)) -ne 0) { $unavailable = $true }
            }
            if ($revoked) { $facts.chain = 'revoked' }
            elseif ($unavailable) { $facts.chain = 'revocation-unavailable' }
        }
    } catch { $facts.chain = 'error' }
    finally { if ($null -ne $chain) { try { $chain.Dispose() } catch {} } }
    return [PSCustomObject]$facts
}

$bytes = $null; $certificates = $null; $report = $null
$failure = 'CERTIFICATE_LOAD_FAILED'
try {
    $bytes = [Convert]::FromBase64String($env:WIN_CSC_LINK)
    $certificates = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection
    # EphemeralKeySet is mandatory. No fallback to disk-backed key storage on an unsupported host.
    $certificates.Import($bytes, $env:WIN_CSC_KEY_PASSWORD,
        [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
    $env:WIN_CSC_LINK = $null; $env:WIN_CSC_KEY_PASSWORD = $null
    $failure = 'PROBE_INTERNAL_FAILED'
    $report = Get-IdentityFacts -Certificates $certificates -Expected $env:WIN_CSC_EXPECTED_SUBJECT
} catch { $report = $null }
finally {
    $env:WIN_CSC_LINK = $null; $env:WIN_CSC_KEY_PASSWORD = $null; $env:WIN_CSC_EXPECTED_SUBJECT = $null
    if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    if ($null -ne $certificates) {
        foreach ($certificate in $certificates) { try { $certificate.Dispose() } catch {} }
        $certificates.Clear()
    }
}
try {
    if ($null -eq $report) { [Console]::Out.WriteLine('{"failure":"' + $failure + '"}'); exit 1 }
    # Facts stay in the supervisor's bounded pipe. Only its fixed category and SHA reach Actions logs.
    [Console]::Out.WriteLine(($report | ConvertTo-Json -Compress))
} catch { [Console]::Out.WriteLine('{"failure":"PROBE_INTERNAL_FAILED"}'); exit 1 }
