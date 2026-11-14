param([ValidateSet('cmb.pb','com.tencent.mm')][string]$Package = 'cmb.pb')
$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\deploy-artifacts\finance-capture-test'))
New-Item -ItemType Directory -Path $taskRoot -Force | Out-Null
$sdkRoot = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$jdkRoot = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin' } else { Split-Path (Get-Command java.exe).Source -Parent }
$buildTools = Join-Path $sdkRoot 'build-tools\36.1.0'
$androidJar = Join-Path $sdkRoot 'platforms\android-36\android.jar'
$fixtureRoot = Join-Path $taskRoot $Package
$classesRoot = Join-Path $fixtureRoot 'classes'
$dexRoot = Join-Path $fixtureRoot 'dex'
New-Item -ItemType Directory -Path $classesRoot,$dexRoot -Force | Out-Null
$source = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\tests\android-finance-fixture\MainActivity.java') -Raw).Replace('FIXTURE_PACKAGE', $Package)
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'MainActivity.java'), $source)
$manifest = '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="' + $Package + '"><uses-permission android:name="android.permission.POST_NOTIFICATIONS"/><application android:label="Finance Test Fixture"><activity android:name=".MainActivity" android:exported="true"/></application></manifest>'
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'AndroidManifest.xml'), $manifest)
& (Join-Path $jdkRoot 'javac.exe') '-encoding' 'UTF-8' '-source' '8' '-target' '8' '-cp' $androidJar '-d' $classesRoot (Join-Path $fixtureRoot 'MainActivity.java')
if ($LASTEXITCODE -ne 0) { throw 'Fixture Java compilation failed' }
$classFile = Join-Path $classesRoot ($Package.Replace('.','\') + '\MainActivity.class')
& (Join-Path $buildTools 'd8.bat') '--lib' $androidJar '--min-api' '28' '--output' $dexRoot $classFile
if ($LASTEXITCODE -ne 0) { throw 'Fixture dex compilation failed' }
$unsigned = Join-Path $fixtureRoot 'unsigned.apk'
& (Join-Path $buildTools 'aapt2.exe') 'link' '-o' $unsigned '-I' $androidJar '--manifest' (Join-Path $fixtureRoot 'AndroidManifest.xml') '--min-sdk-version' '28' '--target-sdk-version' '36'
if ($LASTEXITCODE -ne 0) { throw 'Fixture packaging failed' }
& (Join-Path $jdkRoot 'jar.exe') 'uf' $unsigned '-C' $dexRoot 'classes.dex'
$key = Join-Path $taskRoot 'fixture.keystore'
if (-not (Test-Path -LiteralPath $key)) {
  & (Join-Path $jdkRoot 'keytool.exe') '-genkeypair' '-keystore' $key '-storepass' 'android' '-alias' 'fixture' '-keypass' 'android' '-dname' 'CN=Emulator Fixture' '-keyalg' 'RSA' '-validity' '365' | Out-Null
}
$apk = Join-Path $fixtureRoot 'fixture.apk'
& (Join-Path $buildTools 'apksigner.bat') 'sign' '--ks' $key '--ks-pass' 'pass:android' '--key-pass' 'pass:android' '--out' $apk $unsigned
if ($LASTEXITCODE -ne 0) { throw 'Fixture signing failed' }
Write-Output $apk
