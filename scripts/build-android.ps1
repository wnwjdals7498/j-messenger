[CmdletBinding()]
param(
    [switch]$Test,
    [string]$Device = 'emulator-5554',
    [string]$ShortTemp = 'D:\jmtmp'
)
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$androidProject = Join-Path $repository 'apps/android'
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
$jdk = 'C:\Program Files\Android\Android Studio\jbr'
if (!(Test-Path -LiteralPath (Join-Path $jdk 'bin/javac.exe'))) { throw 'Android Studio JDK is required' }
$distribution = Join-Path $env:USERPROFILE '.gradle/wrapper/dists/gradle-9.3.1-all'
$gradle = Join-Path $androidProject 'gradlew.bat'
if (!(Test-Path -LiteralPath $gradle)) { $gradle = @(Get-ChildItem -LiteralPath $distribution -Directory | ForEach-Object {
    $candidate = Join-Path $_.FullName 'gradle-9.3.1/bin/gradle.bat'
    if (Test-Path -LiteralPath $candidate) { $candidate }
}) | Select-Object -First 1 }
if (!$gradle) { throw 'Install Gradle 9.3.1 from its official distribution first' }
New-Item -ItemType Directory -Path $ShortTemp -Force | Out-Null
$previous = @{ TEMP=$env:TEMP; TMP=$env:TMP; JAVA_HOME=$env:JAVA_HOME; JAVA_TOOL_OPTIONS=$env:JAVA_TOOL_OPTIONS; ANDROID_HOME=$env:ANDROID_HOME }
Push-Location $repository
try {
    npm run build:contracts
    if ($LASTEXITCODE -ne 0) { throw 'Shared contract build failed' }
    npm run build --workspace=@j-messenger/client-core
    if ($LASTEXITCODE -ne 0) { throw 'Client build failed' }
    npm run build --workspace=@j-messenger/client-react
    if ($LASTEXITCODE -ne 0) { throw 'UI build failed' }
    npm run build --workspace=@j-messenger/web
    if ($LASTEXITCODE -ne 0) { throw 'Web build failed' }
    $env:TEMP = $ShortTemp
    $env:TMP = $ShortTemp
    $env:JAVA_HOME = $jdk
    $env:JAVA_TOOL_OPTIONS = '-Djava.io.tmpdir=' + $ShortTemp.Replace('\','/')
    $env:ANDROID_HOME = $sdk
    $tasks = @(':app:assembleDebug', ':app:lintDebug')
    if ($Test) { $tasks += ':app:assembleDebugAndroidTest' }
    & $gradle -p $androidProject --no-daemon @tasks
    if ($LASTEXITCODE -ne 0) { throw 'Android build failed' }
    if ($Test) {
        $adb = Join-Path $sdk 'platform-tools/adb.exe'
        $name = & $adb -s $Device emu avd name
        if ($LASTEXITCODE -ne 0 -or !($name) -or $name[0].Trim() -cne 'Pixel_10') { throw 'Only the named Pixel_10 emulator is approved' }
        $boot = & $adb -s $Device shell getprop sys.boot_completed
        if ($LASTEXITCODE -ne 0 -or ($boot -join '').Trim() -ne '1') { throw 'Wait until Pixel_10 finishes booting before testing' }
        $fixtureDirectory = Join-Path $repository '.tools/android'
        New-Item -ItemType Directory -Path $fixtureDirectory -Force | Out-Null
        $fixture = Join-Path $fixtureDirectory 'jmessenger-android-fixture.txt'
        [IO.File]::WriteAllBytes($fixture,[Text.Encoding]::UTF8.GetBytes('Android VM attachment round trip'))
        & $adb -s $Device push $fixture /sdcard/Download/jmessenger-android-fixture.txt
        if ($LASTEXITCODE -ne 0) { throw 'Android test fixture setup failed' }
        & $adb -s $Device shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Download/jmessenger-android-fixture.txt | Out-Null
        & $adb -s $Device install -r (Join-Path $androidProject 'app/build/outputs/apk/debug/app-debug.apk')
        if ($LASTEXITCODE -ne 0) { throw 'App installation failed' }
        & $adb -s $Device install -r (Join-Path $androidProject 'app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk')
        if ($LASTEXITCODE -ne 0) { throw 'Test installation failed' }
        $result = & $adb -s $Device shell am instrument -w -r -e class com.jmessenger.android.MessengerInstrumentedTest com.jmessenger.android.lab.test/androidx.test.runner.AndroidJUnitRunner
        $result | Write-Output
        if ($LASTEXITCODE -ne 0 -or ($result -join "`n") -notmatch 'OK \(\d+ tests?\)' -or ($result -join "`n") -match 'FAILURES|INSTRUMENTATION_FAILED') { throw 'Android device verification failed' }
    }
} finally {
    Pop-Location
    foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key,$previous[$key],'Process') }
}
