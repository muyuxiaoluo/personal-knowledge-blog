param(
  [ValidateSet('aarch64','x86_64')][string[]]$Targets = @('aarch64'),
  [switch]$DebugBuild
)
$ErrorActionPreference = 'Stop'
$appRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$androidRoot = Join-Path $appRoot 'src-tauri\gen\android'
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
if (-not $env:JAVA_HOME) { $env:JAVA_HOME = Split-Path (Split-Path (Get-Command java.exe).Source -Parent) -Parent }
if (-not $env:NDK_HOME) {
  $ndk = Get-ChildItem -LiteralPath (Join-Path $env:ANDROID_HOME 'ndk') -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName 'source.properties') } |
    Sort-Object Name -Descending | Select-Object -First 1
  if (-not $ndk) { throw '请先安装 Android NDK，并设置 NDK_HOME。' }
  $env:NDK_HOME = $ndk.FullName
}
if (-not (Test-Path (Join-Path $androidRoot 'gradlew.bat'))) { throw '请先运行 npm run tauri -- android init --skip-targets-install --ci。' }
$manifest = Get-Content -LiteralPath (Join-Path $androidRoot 'app\src\main\AndroidManifest.xml') -Raw
foreach ($required in @('android:allowBackup="false"','android:usesCleartextTraffic="false"','android:networkSecurityConfig="@xml/network_security_config"','android:dataExtractionRules="@xml/data_extraction_rules"')) {
  if (-not $manifest.Contains($required)) { throw 'Android 工程缺少私人数据保护配置。若重新运行过 init，请恢复仓库中的清单和网络/备份规则后再构建。' }
}
$buildTools = Get-ChildItem -LiteralPath (Join-Path $env:ANDROID_HOME 'build-tools') -Directory |
  Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $buildTools) { throw '请先安装 Android SDK build-tools。' }
$apksigner = Join-Path $buildTools.FullName 'apksigner.bat'
$zipalign = Join-Path $buildTools.FullName 'zipalign.exe'
function Get-ApkCertificate([string]$Path) {
  $result = & $apksigner verify --print-certs $Path 2>&1
  if ($LASTEXITCODE -ne 0) { throw "安装包签名验证失败：$Path" }
  $digest = [regex]::Match(($result -join "`n"), 'Signer #1 certificate SHA-256 digest: ([a-fA-F0-9]+)').Groups[1].Value
  if (-not $digest) { throw "未取得安装包签名：$Path" }
  return $digest
}
# The default is a locally signed, optimized build of the one companion app.
$outputRoot = [IO.Path]::GetFullPath((Join-Path $appRoot '..\deploy-artifacts\android'))
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
$variant = if ($DebugBuild) { 'debug' } else { 'release' }
$variantTitle = if ($DebugBuild) { 'Debug' } else { 'Release' }
$overrides = @{
  'ORG_GRADLE_PROJECT_workbenchLocalSigning' = 'true'
  'ORG_GRADLE_PROJECT_kotlin.incremental' = 'false'
  'ORG_GRADLE_PROJECT_kotlin.compiler.execution.strategy' = 'in-process'
}
if (-not $DebugBuild) {
  # Scope optimization to this Android command; desktop release settings are untouched.
  $overrides['CARGO_PROFILE_RELEASE_OPT_LEVEL'] = 's'
  $overrides['CARGO_PROFILE_RELEASE_LTO'] = 'thin'
  $overrides['CARGO_PROFILE_RELEASE_CODEGEN_UNITS'] = '1'
  $overrides['CARGO_PROFILE_RELEASE_DEBUG'] = '0'
  $overrides['CARGO_PROFILE_RELEASE_STRIP'] = 'symbols'
}
$previous = @{}
foreach ($name in $overrides.Keys) {
  $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  [Environment]::SetEnvironmentVariable($name, $overrides[$name], 'Process')
}
try {
  foreach ($target in $Targets) {
    $arch = if ($target -eq 'aarch64') { 'Arm64' } else { 'X86_64' }
    $abi = if ($target -eq 'aarch64') { 'arm64-v8a' } else { 'x86_64' }
    $gradleArch = if ($target -eq 'aarch64') { 'arm64' } else { 'x86_64' }
    $deliveryArch = if ($target -eq 'aarch64') { 'arm64' } else { 'x86_64' }
    $suffix = if ($DebugBuild) { '-debug' } else { '' }
    $delivered = Join-Path $outputRoot "personal-workbench-$deliveryArch$suffix.apk"
    $baseline = if (Test-Path -LiteralPath $delivered) { $delivered } else { Join-Path $outputRoot "personal-workbench-$deliveryArch-debug.apk" }
    $expectedCertificate = if (Test-Path -LiteralPath $baseline) { Get-ApkCertificate $baseline } else { $null }
    $log = Join-Path $outputRoot "tauri-$target-$variant.log"
    $apk = Join-Path $androidRoot "app\build\outputs\apk\$gradleArch\$variant\app-$gradleArch-$variant.apk"
    # An existing ZIP retains free regions when native libraries are replaced.
    # Removing only this generated output forces a fresh package while retaining compiler caches.
    if (Test-Path -LiteralPath $apk) { Remove-Item -LiteralPath $apk -Force }
    $arguments = @('run','tauri','--','android','build','--apk','--target',$target)
    if ($DebugBuild) { $arguments += '--debug' }
    Push-Location $appRoot
    try {
      $ErrorActionPreference = 'Continue'
      & npm.cmd @arguments *> $log
      $tauriExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = 'Stop'; Pop-Location }
    if ($tauriExit -ne 0) {
      $buildOutput = [regex]::Replace((Get-Content -LiteralPath $log -Raw), '\x1b\[[0-9;]*m', '')
      $library = Join-Path $appRoot "src-tauri\target\$target-linux-android\$variant\liblife_strategy_library_lib.so"
      $profile = if ($DebugBuild) { 'dev' } else { 'release' }
      # Only the known Windows symlink failure permits packaging a compiled library copy.
      if ($buildOutput -notmatch 'Failed to create a symbolic link' -or -not $buildOutput.Contains(('Finished `{0}` profile' -f $profile)) -or -not (Test-Path -LiteralPath $library)) {
        Get-Content -LiteralPath $log -Tail 45
        throw "Android 编译失败，详见 $log"
      }
      $jni = Join-Path $androidRoot "app\src\main\jniLibs\$abi"
      New-Item -ItemType Directory -Path $jni -Force | Out-Null
      Copy-Item -LiteralPath $library -Destination (Join-Path $jni 'liblife_strategy_library_lib.so') -Force
      Push-Location $androidRoot
      try {
        $ErrorActionPreference = 'Continue'
        & .\gradlew.bat ":app:assemble$arch$variantTitle" '-x' ":app:rustBuild$arch$variantTitle" "-PabiList=$abi" "-ParchList=$gradleArch" "-PtargetList=$target" '--console=plain' >> $log 2>&1
        $gradleExit = $LASTEXITCODE
      } finally { $ErrorActionPreference = 'Stop'; Pop-Location }
      if ($gradleExit -ne 0) { Get-Content -LiteralPath $log -Tail 45; throw 'Android Gradle 打包失败。' }
    }
    if (-not (Test-Path -LiteralPath $apk)) { throw "未找到 APK：$apk" }
    $certificate = Get-ApkCertificate $apk
    if ($expectedCertificate -and $certificate -ne $expectedCertificate) { throw '新旧安装包签名不一致，已停止交付，以免无法保留数据覆盖升级。' }
    & $zipalign '-c' '-P' '16' '4' $apk >> $log 2>&1
    if ($LASTEXITCODE -ne 0) { throw "APK 对齐检查失败，详见 $log" }
    $checkArguments = @((Join-Path $PSScriptRoot 'check-android-apk.mjs'), $apk, '--abi', $abi)
    if ($DebugBuild) { $checkArguments += '--allow-debug-symbols' }
    $report = & node.exe @checkArguments
    if ($LASTEXITCODE -ne 0) { throw 'APK 体积与原生库检查失败，已停止交付。' }
    # Replace the deliverable only after compilation, signature, alignment and size checks pass.
    Copy-Item -LiteralPath $apk -Destination $delivered -Force
    [IO.File]::WriteAllText("$delivered.analysis.json", ($report -join [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    $mapping = Join-Path $androidRoot "app\build\outputs\mapping\$gradleArch$variantTitle\mapping.txt"
    if (Test-Path -LiteralPath $mapping) { Copy-Item -LiteralPath $mapping -Destination (Join-Path $outputRoot "mapping-$deliveryArch.txt") -Force }
    Write-Output "APK: $delivered ($([Math]::Round((Get-Item -LiteralPath $delivered).Length / 1MB, 2)) MiB)"
  }
} finally {
  foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
