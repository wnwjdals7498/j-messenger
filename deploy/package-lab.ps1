[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$revision = (git -C $repositoryRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Repository revision unavailable' }
$release = $revision.Substring(0, 7) + '-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$payload = Join-Path $repositoryRoot ('.tools/vm-deploy/' + $release + '/payload')
if (Test-Path -LiteralPath $payload) { throw 'Release staging already exists' }
New-Item -ItemType Directory -Path $payload -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'package.json'),(Join-Path $repositoryRoot 'package-lock.json') -Destination $payload
foreach ($workspace in @('apps/server','apps/web','apps/desktop','packages/contracts','packages/client-core','packages/client-react')) {
    $destination = Join-Path $payload $workspace
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $repositoryRoot ($workspace + '/package.json')) -Destination $destination
    if ($workspace -ne 'apps/desktop') {
        Copy-Item -LiteralPath (Join-Path $repositoryRoot ($workspace + '/dist')) -Destination $destination -Recurse
    }
}
$deployDirectory = Join-Path $payload 'deploy'
New-Item -ItemType Directory -Path $deployDirectory -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'deploy/j-messenger.service') -Destination $deployDirectory
foreach ($helper in @('vm-profile.mjs','vm-profile.sh')) {
    Copy-Item -LiteralPath (Join-Path $repositoryRoot ('deploy/' + $helper)) -Destination $deployDirectory
}
git -C $repositoryRoot diff --quiet HEAD -- apps/server/src packages/contracts/src packages/client-core/src packages/client-react/src apps/web/src
$runtimeSourceModified = $LASTEXITCODE -ne 0
$metadata = [ordered]@{release=$release; sourceCommit=$revision; runtimeSourceModified=$runtimeSourceModified; builtAt=(Get-Date).ToUniversalTime().ToString('o')}
[IO.File]::WriteAllText((Join-Path $payload 'release.json'),($metadata | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
$archive = Join-Path (Split-Path $payload) ($release + '.tar.gz')
tar -czf $archive -C $payload .
if ($LASTEXITCODE -ne 0) { throw 'Release archive failed' }
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
[ordered]@{release=$release; sha256=$hash; archive=$archive; bytes=(Get-Item -LiteralPath $archive).Length; runtimeSourceModified=$runtimeSourceModified} | ConvertTo-Json -Compress
