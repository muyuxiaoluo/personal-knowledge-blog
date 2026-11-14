param(
    [string]$Python = 'D:\AI voice\Qianyu-TTS\engine\runtime\python.exe',
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'PersonalWorkbench/asr'),
    [string]$Archive = ''
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
$modelName = 'sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30'
$model = Join-Path $Destination $modelName
$runtime = Join-Path $Destination 'venv'
if (!(Test-Path (Join-Path $runtime 'Scripts/python.exe'))) {
    & $Python -m venv --without-pip $runtime
    if ($LASTEXITCODE) { throw 'Cannot create dictation environment' }
}
& $Python -m pip --python (Join-Path $runtime 'Scripts/python.exe') install 'sherpa-onnx==2.0.1' 'sounddevice==0.5.6' 'numpy>=1.26,<3'
if ($LASTEXITCODE) { throw 'Cannot install dictation dependencies' }
if (!(Test-Path (Join-Path $model 'encoder.int8.onnx'))) {
    if (!$Archive) {
        $Archive = Join-Path $Destination 'model.tar.bz2'
        & curl.exe -L --fail --retry 2 "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$modelName.tar.bz2" -o $Archive
        if ($LASTEXITCODE) { throw 'Cannot download model' }
    }
    & tar.exe -xf $Archive -C $Destination
    if ($LASTEXITCODE) { throw 'Cannot extract model' }
}
@{ python = (Join-Path $runtime 'Scripts/python.exe'); model = $model } | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $Destination 'runtime.json')
Write-Output "Local dictation installed at $Destination"
