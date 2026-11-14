param([string]$Destination = (Join-Path $env:LOCALAPPDATA 'PersonalWorkbench/assistant-runtime'))
$ErrorActionPreference = 'Stop'
$runtimeDirectory = [IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
& npm.cmd install --prefix $runtimeDirectory '@deepseek-ai/dsh@0.2.2-rc.1' --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'DeepSeek Harness installation failed.' }
Write-Output "Assistant runtime installed at $runtimeDirectory"
