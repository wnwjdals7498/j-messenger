[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$CertificateFile,
    [Parameter(Mandatory)][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$ExpectedSha256
)
$ErrorActionPreference='Stop'
$certificatePath=(Resolve-Path -LiteralPath $CertificateFile).Path
$certificate=[Security.Cryptography.X509Certificates.X509Certificate2]::new([IO.File]::ReadAllBytes($certificatePath))
try {
    if ($certificate.HasPrivateKey -or $certificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256) -ine $ExpectedSha256) { throw 'Public CA identity mismatch' }
    $constraints=@($certificate.Extensions | Where-Object {$_.Oid.Value -eq '2.5.29.19'})
    if ($constraints.Count -ne 1 -or !([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($constraints[0],$constraints[0].Critical)).CertificateAuthority) { throw 'Expected a CA certificate' }
    if ($certificate.NotBefore.ToUniversalTime() -gt [DateTime]::UtcNow -or $certificate.NotAfter.ToUniversalTime() -le [DateTime]::UtcNow) { throw 'CA is outside its validity period' }
    $store=[Security.Cryptography.X509Certificates.X509Store]::new('Root','CurrentUser')
    try {
        $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
        $exists=@($store.Certificates | Where-Object {$_.Thumbprint -eq $certificate.Thumbprint}).Count -gt 0
    } finally { $store.Close() }
    if (!$exists -and $PSCmdlet.ShouldProcess($certificate.Thumbprint,'Trust the verified public CA in CurrentUser Root')) {
        Import-Certificate -FilePath $certificatePath -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null
    }
    if (!$WhatIfPreference) {
        $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
        try { if (@($store.Certificates | Where-Object {$_.Thumbprint -eq $certificate.Thumbprint}).Count -eq 0) { throw 'CA trust was not registered' } } finally { $store.Close() }
        Write-Output "Verified CA trusted for current user: $($certificate.Thumbprint)"
    }
} finally { $certificate.Dispose() }
