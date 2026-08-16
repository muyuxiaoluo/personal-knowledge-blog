[CmdletBinding()]
param(
  [ValidateSet("Prepare", "Tag")]
  [string]$Stage = "Prepare",
  [string]$ExpectedVersion = ""
)

$ErrorActionPreference = "Stop"
$script:Failures = 0
$script:Warnings = 0

function Write-Pass([string]$Message) {
  Write-Host "[PASS] $Message" -ForegroundColor Green
}

function Write-WarningResult([string]$Message) {
  $script:Warnings += 1
  Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Write-Failure([string]$Message) {
  $script:Failures += 1
  Write-Host "[FAIL] $Message" -ForegroundColor Red
}

function Read-Json([string]$Path) {
  return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json -AsHashtable
}

function Get-CargoPackageVersion([string]$Path) {
  $content = Get-Content -Raw -LiteralPath $Path
  $match = [regex]::Match($content, '(?ms)^\[package\]\s+.*?^version\s*=\s*"([^"]+)"')
  if (-not $match.Success) { throw "无法读取 $Path 的 [package].version" }
  return $match.Groups[1].Value
}

function Get-CargoLockPackageVersion([string]$Path) {
  $content = Get-Content -Raw -LiteralPath $Path
  $match = [regex]::Match($content, '(?ms)^\[\[package\]\]\s+name\s*=\s*"life-strategy-library"\s+version\s*=\s*"([^"]+)"')
  if (-not $match.Success) { throw "无法读取 $Path 中 life-strategy-library 的版本" }
  return $match.Groups[1].Value
}

function Get-UpdaterFallbackVersion([string]$Path) {
  $content = Get-Content -Raw -LiteralPath $Path
  $match = [regex]::Match($content, 'useState\("(\d+\.\d+\.\d+)"\)')
  if (-not $match.Success) { throw "无法读取 $Path 的更新器回退版本" }
  return $match.Groups[1].Value
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")
Push-Location $repoRoot
try {
  Write-Host "发布预检：$Stage" -ForegroundColor Cyan
  Write-Host "仓库：$repoRoot"

  $requiredFiles = @(
    ".github/workflows/quality.yml",
    ".github/workflows/release-windows.yml",
    "CHANGELOG.md",
    "package.json",
    "package-lock.json",
    "sites-app/package.json",
    "sites-app/package-lock.json",
    "sites-app/src-tauri/Cargo.toml",
    "sites-app/src-tauri/Cargo.lock",
    "sites-app/src-tauri/tauri.conf.json",
    "sites-app/desktop/AppUpdater.tsx",
    "sync-server/package.json"
  )
  foreach ($file in $requiredFiles) {
    if (Test-Path -LiteralPath $file) { Write-Pass "存在 $file" }
    else { Write-Failure "缺少 $file" }
  }

  if ($script:Failures -gt 0) { throw "缺少发布所需文件" }

  $rootPackage = Read-Json "package.json"
  $rootLock = Read-Json "package-lock.json"
  $desktopPackage = Read-Json "sites-app/package.json"
  $desktopLock = Read-Json "sites-app/package-lock.json"
  $tauriConfig = Read-Json "sites-app/src-tauri/tauri.conf.json"
  $syncPackage = Read-Json "sync-server/package.json"

  $versions = [ordered]@{
    "package.json" = [string]$rootPackage["version"]
    "package-lock.json" = [string]$rootLock["version"]
    "package-lock.json 根包" = [string]$rootLock["packages"][""]["version"]
    "sites-app/package.json" = [string]$desktopPackage["version"]
    "sites-app/package-lock.json" = [string]$desktopLock["version"]
    "sites-app/package-lock.json 根包" = [string]$desktopLock["packages"][""]["version"]
    "sites-app/src-tauri/Cargo.toml" = Get-CargoPackageVersion "sites-app/src-tauri/Cargo.toml"
    "sites-app/src-tauri/Cargo.lock" = Get-CargoLockPackageVersion "sites-app/src-tauri/Cargo.lock"
    "sites-app/src-tauri/tauri.conf.json" = [string]$tauriConfig["version"]
    "sites-app/desktop/AppUpdater.tsx" = Get-UpdaterFallbackVersion "sites-app/desktop/AppUpdater.tsx"
    "sync-server/package.json" = [string]$syncPackage["version"]
  }

  $distinctVersions = @($versions.Values | Sort-Object -Unique)
  foreach ($entry in $versions.GetEnumerator()) {
    Write-Host ("  {0}: {1}" -f $entry.Key, $entry.Value)
  }
  if ($distinctVersions.Count -eq 1) {
    Write-Pass "所有版本来源一致：$($distinctVersions[0])"
  } else {
    Write-Failure "版本来源不一致：$($distinctVersions -join ', ')"
  }

  $resolvedVersion = if ($ExpectedVersion) { $ExpectedVersion } else { $distinctVersions[0] }
  if ($resolvedVersion -notmatch '^\d+\.\d+\.\d+$') {
    Write-Failure "版本必须是稳定的 X.Y.Z 格式：$resolvedVersion"
  }
  if ($ExpectedVersion) {
    foreach ($entry in $versions.GetEnumerator()) {
      if ($entry.Value -ne $ExpectedVersion) {
        Write-Failure "$($entry.Key) 不是期望版本 $ExpectedVersion"
      }
    }
  }

  $branch = (git branch --show-current).Trim()
  if ($branch -eq "main") { Write-Pass "当前分支是 main" }
  else { Write-WarningResult "当前分支是 $branch，不是 main" }

  $status = @(git status --porcelain)
  if ($status.Count -eq 0) {
    Write-Pass "工作区干净"
  } elseif ($Stage -eq "Tag") {
    Write-Failure "Tag 阶段要求工作区干净"
  } else {
    Write-WarningResult "准备阶段仍有 $($status.Count) 条未提交变更"
  }

  git diff --check 2>$null | Out-Host
  if ($LASTEXITCODE -eq 0) { Write-Pass "git diff --check 通过" }
  else { Write-Failure "git diff --check 失败" }

  $changelog = Get-Content -Raw -LiteralPath "CHANGELOG.md"
  if ($Stage -eq "Tag") {
    if ($changelog -match "(?m)^## v$([regex]::Escape($resolvedVersion))\s+[—-]\s+\d{4}-\d{2}-\d{2}\s*$") {
      Write-Pass "CHANGELOG.md 包含 v$resolvedVersion 正式版本标题"
    } else {
      Write-Failure "CHANGELOG.md 缺少 v$resolvedVersion 的正式日期标题"
    }
  } elseif ($changelog -match '(?m)^## 未发布\s*$') {
    Write-Pass "CHANGELOG.md 包含未发布章节"
  } else {
    Write-WarningResult "CHANGELOG.md 没有未发布章节"
  }

  $releaseWorkflow = Get-Content -Raw -LiteralPath ".github/workflows/release-windows.yml"
  if ($releaseWorkflow -match '(?m)^\s*-\s+"v\*"\s*$') {
    Write-Pass "桌面发布工作流监听 v* 标签"
  } else {
    Write-Failure "桌面发布工作流未识别到 v* 标签触发器"
  }
  if ($releaseWorkflow -match 'TAURI_SIGNING_PRIVATE_KEY') {
    Write-Pass "桌面发布工作流声明更新签名密钥"
  } else {
    Write-Failure "桌面发布工作流未声明 TAURI_SIGNING_PRIVATE_KEY"
  }

  if ($Stage -eq "Tag") {
    if ($branch -ne "main") { Write-Failure "只能从 main 创建正式发布标签" }

    git show-ref --verify --quiet refs/remotes/origin/main
    if ($LASTEXITCODE -ne 0) {
      Write-Failure "本地没有 origin/main；先获取远端状态"
    } else {
      $aheadBehind = (git rev-list --left-right --count main...origin/main).Trim() -split '\s+'
      if ($aheadBehind.Count -eq 2 -and $aheadBehind[0] -eq "0" -and $aheadBehind[1] -eq "0") {
        Write-Pass "main 与 origin/main 一致"
      } else {
        Write-Failure "main 与 origin/main 不一致：本地独有 $($aheadBehind[0])，远端独有 $($aheadBehind[1])"
      }
    }

    $tag = "v$resolvedVersion"
    git show-ref --tags --verify --quiet "refs/tags/$tag"
    if ($LASTEXITCODE -eq 0) { Write-Failure "本地标签 $tag 已存在" }
    else { Write-Pass "本地标签 $tag 不存在" }

    $remoteTag = @(git ls-remote --tags origin "refs/tags/$tag")
    if ($LASTEXITCODE -ne 0) {
      Write-Failure "无法检查远端标签 $tag"
    } elseif ($remoteTag.Count -gt 0) {
      Write-Failure "远端标签 $tag 已存在"
    } else {
      Write-Pass "远端标签 $tag 不存在"
    }

    $head = (git rev-parse HEAD).Trim()
    $originMain = (git rev-parse origin/main).Trim()
    if ($head -eq $originMain) { Write-Pass "HEAD 就是 origin/main：$head" }
    else { Write-Failure "HEAD 不是 origin/main" }
  }
}
catch {
  Write-Failure $_.Exception.Message
}
finally {
  Pop-Location
}

Write-Host ""
Write-Host "结果：$script:Failures 个失败，$script:Warnings 个警告"
if ($script:Failures -gt 0) { exit 1 }
exit 0
