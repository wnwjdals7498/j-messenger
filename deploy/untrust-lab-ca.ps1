[CmdletBinding(SupportsShouldProcess)]
param()
$ErrorActionPreference = 'Stop'
$thumbprint = '08F2139AFC102ABB86ACF08E76ED30128D2DC711'
$path = 'Cert:\CurrentUser\Root\' + $thumbprint
if (Test-Path -LiteralPath $path) {
    $certificate = Get-Item -LiteralPath $path
    if ($certificate.GetCertHashString([Security.Cryptography.HashAlgorithmName]::SHA256) -ne 'DA1DDD9CB6B2B3C05A3AC9771D45748B7EA888AF10D850A01CBD11896B8B31E0') {
        throw 'Lab certificate identity mismatch'
    }
    if ($PSCmdlet.ShouldProcess('Current Windows user trusted roots','Remove only J Messenger Lab Development CA')) {
        Remove-Item -LiteralPath $path
    }
}
