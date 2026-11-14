param([switch]$CheckOnly, [switch]$ConnectDesktop)
$ErrorActionPreference = 'Stop'
$toolRoot = $PSScriptRoot
$localRoot = Join-Path $toolRoot '.local'
$pythonPath = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
  $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
  if (-not $pythonCommand -or $pythonCommand.Source -like '*WindowsApps*') { throw 'Python 3.10+ is required. Ask Codex to prepare the local runtime.' }
  $pythonPath = $pythonCommand.Source
}
$env:PYTHONUTF8 = '1'
if ($CheckOnly) {
  & $pythonPath (Join-Path $toolRoot 'verify.py') --check
  if ($LASTEXITCODE -ne 0) { throw 'Local environment verification failed.' }
  exit 0
}
$manifest = Get-Content -LiteralPath (Join-Path $toolRoot 'upstream.json') -Raw | ConvertFrom-Json
$vendorRoot = Join-Path $localRoot 'vendor'
New-Item -ItemType Directory -Force -Path $vendorRoot | Out-Null
foreach ($entry in $manifest.files.PSObject.Properties) {
  $destination = Join-Path $vendorRoot $entry.Name
  if (-not (Test-Path -LiteralPath $destination)) {
    $uri = 'https://raw.githubusercontent.com/{0}/{1}/{2}' -f $manifest.repository, $manifest.commit, $entry.Name
    Invoke-WebRequest -Uri $uri -OutFile $destination -UseBasicParsing
  }
  $actual = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $entry.Value) { throw ('Upstream file checksum mismatch: ' + $entry.Name) }
}
$runtimeRoot = Join-Path $localRoot 'runtime'
if (-not (Test-Path -LiteralPath (Join-Path $runtimeRoot 'requests/__init__.py'))) {
  & $pythonPath -m pip install --disable-pip-version-check --no-warn-script-location --retries 0 --timeout 25 --target $runtimeRoot 'requests==2.32.5'
  if ($LASTEXITCODE -ne 0) { throw 'Unable to prepare local dependencies.' }
}
if ($ConnectDesktop) {
  & $pythonPath (Join-Path $toolRoot 'desktop_connection.py')
} else {
  & $pythonPath (Join-Path $toolRoot 'verify.py')
}
if ($LASTEXITCODE -ne 0) { throw 'Verification did not finish. Read the message above.' }
