param([ValidateSet('aarch64','x86_64')][string[]]$Targets = @('aarch64'))
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
$outputRoot = Join-Path $appRoot '..\deploy-artifacts\android-mvp'
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
foreach ($target in $Targets) {
  $arch = if ($target -eq 'aarch64') { 'Arm64' } else { 'X86_64' }
  $abi = if ($target -eq 'aarch64') { 'arm64-v8a' } else { 'x86_64' }
  $gradleArch = if ($target -eq 'aarch64') { 'arm64' } else { 'x86_64' }
  $log = Join-Path $outputRoot "tauri-$target.log"
  Push-Location $appRoot
  try {
    $ErrorActionPreference = 'Continue'
    & npm.cmd run tauri -- android build --debug --apk --target $target *> $log
    $tauriExit = $LASTEXITCODE
  } finally { $ErrorActionPreference = 'Stop'; Pop-Location }
  if ($tauriExit -ne 0) {
    $buildOutput = Get-Content -LiteralPath $log -Raw
    $buildOutput = [regex]::Replace($buildOutput, '\x1b\[[0-9;]*m', '')
    $library = Join-Path $appRoot "src-tauri\target\$target-linux-android\debug\liblife_strategy_library_lib.so"
    # A copy is a local packaging alternative on Windows without symlink privileges.
    # Every other compiler/CLI failure remains fatal; never package a stale library.
    if ($buildOutput -notmatch 'Failed to create a symbolic link' -or $buildOutput -notmatch 'Finished `dev` profile' -or -not (Test-Path -LiteralPath $library)) {
      Get-Content -LiteralPath $log -Tail 45
      throw "Android 编译失败，详见 $log"
    }
    $jni = Join-Path $androidRoot "app\src\main\jniLibs\$abi"
    New-Item -ItemType Directory -Path $jni -Force | Out-Null
    Copy-Item -LiteralPath $library -Destination (Join-Path $jni 'liblife_strategy_library_lib.so') -Force
    Push-Location $androidRoot
    try {
      & .\gradlew.bat ":app:assemble${arch}Debug" '-x' ":app:rustBuild${arch}Debug" "-PabiList=$abi" "-ParchList=$gradleArch" "-PtargetList=$target" '--console=plain'
      if ($LASTEXITCODE -ne 0) { throw 'Android Gradle 打包失败。' }
    } finally { Pop-Location }
  }
  $apk = Join-Path $androidRoot "app\build\outputs\apk\$gradleArch\debug\app-$gradleArch-debug.apk"
  if (-not (Test-Path -LiteralPath $apk)) { throw "未找到 debug APK：$apk" }
  $delivered = Join-Path $outputRoot "personal-workbench-$target-debug.apk"
  Copy-Item -LiteralPath $apk -Destination $delivered -Force
  Write-Output "Debug APK: $delivered"
}
