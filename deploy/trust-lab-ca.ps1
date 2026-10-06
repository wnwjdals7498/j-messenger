[CmdletBinding(SupportsShouldProcess)]
param()
$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$certificateFile = Join-Path $repositoryRoot '.tools/vm-deploy/tls/j-messenger-lab-ca.cer'
$certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new([IO.File]::ReadAllBytes($certificateFile))
$expectedSha256 = 'DA1DDD9CB6B2B3C05A3AC9771D45748B7EA888AF10D850A01CBD11896B8B31E0'
if ($certificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256) -ne $expectedSha256 -or $certificate.HasPrivateKey) {
    throw 'Lab certificate identity mismatch'
}
$store = 'Cert:\CurrentUser\Root'
function Test-LabRoot {
    $rootStore = [Security.Cryptography.X509Certificates.X509Store]::new('Root','CurrentUser')
    try {
        $rootStore.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
        return @($rootStore.Certificates | Where-Object { $_.Thumbprint -eq $certificate.Thumbprint }).Count -gt 0
    } finally {
        $rootStore.Close()
    }
}
if (!(Test-LabRoot) -and $PSCmdlet.ShouldProcess('Current Windows user trusted roots','Trust verified J Messenger Lab Development CA')) {
    Import-Certificate -FilePath $certificateFile -CertStoreLocation $store | Out-Null
}
if (!$WhatIfPreference) {
    if (!(Test-LabRoot)) { throw 'Lab certificate trust was not added' }
    Write-Output "Lab CA trusted for current user: $($certificate.Thumbprint)"
}
