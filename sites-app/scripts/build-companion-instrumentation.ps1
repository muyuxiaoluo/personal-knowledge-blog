$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\deploy-artifacts\android-instrumentation'))
New-Item -ItemType Directory -Path $taskRoot -Force | Out-Null
$sdkRoot = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$jdkRoot = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin' } else { Split-Path (Get-Command java.exe).Source -Parent }
$buildTools = Join-Path $sdkRoot 'build-tools\36.1.0'
$androidJar = Join-Path $sdkRoot 'platforms\android-36\android.jar'
$classes = Join-Path $taskRoot 'classes'
$dex = Join-Path $taskRoot 'dex'
New-Item -ItemType Directory -Path $classes,$dex -Force | Out-Null
$manifest = '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.muyuxiaoluo.workbenchchecks"><application android:label="Companion build checks" android:debuggable="true"/><instrumentation android:name=".CompanionChecks" android:targetPackage="com.muyuxiaoluo.workbench" android:functionalTest="true"/></manifest>'
[IO.File]::WriteAllText((Join-Path $taskRoot 'AndroidManifest.xml'), $manifest)
& (Join-Path $jdkRoot 'javac.exe') '-encoding' 'UTF-8' '-source' '8' '-target' '8' '-cp' $androidJar '-d' $classes (Join-Path $PSScriptRoot '..\tests\android-companion-instrumentation\CompanionChecks.java')
if ($LASTEXITCODE -ne 0) { throw 'Instrumentation Java compilation failed' }
$classFiles = @(Get-ChildItem -LiteralPath $classes -Recurse -Filter '*.class' | ForEach-Object { $_.FullName })
& (Join-Path $buildTools 'd8.bat') '--lib' $androidJar '--min-api' '28' '--output' $dex @classFiles
if ($LASTEXITCODE -ne 0) { throw 'Instrumentation dex compilation failed' }
$unsigned = Join-Path $taskRoot 'unsigned.apk'
& (Join-Path $buildTools 'aapt2.exe') 'link' '-o' $unsigned '-I' $androidJar '--manifest' (Join-Path $taskRoot 'AndroidManifest.xml') '--min-sdk-version' '28' '--target-sdk-version' '36'
if ($LASTEXITCODE -ne 0) { throw 'Instrumentation packaging failed' }
& (Join-Path $jdkRoot 'jar.exe') 'uf' $unsigned '-C' $dex 'classes.dex'
if ($LASTEXITCODE -ne 0) { throw 'Instrumentation dex packaging failed' }
$apk = Join-Path $taskRoot 'companion-checks.apk'
& (Join-Path $buildTools 'apksigner.bat') 'sign' '--ks' (Join-Path $env:USERPROFILE '.android\debug.keystore') '--ks-key-alias' 'androiddebugkey' '--ks-pass' 'pass:android' '--out' $apk $unsigned
if ($LASTEXITCODE -ne 0) { throw 'Instrumentation signing failed' }
Write-Output $apk
