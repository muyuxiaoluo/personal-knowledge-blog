# 调试版与正式版本地数据库双向同步脚本
# 用法(在 sites-app 目录下执行):
#   powershell -ExecutionPolicy Bypass -File scripts\sync-dev-db.ps1 prod-to-dev   # 正式 -> 调试(默认,调试前拉取正式数据)
#   powershell -ExecutionPolicy Bypass -File scripts\sync-dev-db.ps1 dev-to-prod   # 调试 -> 正式(调试完写回,请谨慎)
param(
    [ValidateSet("prod-to-dev", "dev-to-prod")]
    [string]$Direction = "prod-to-dev"
)

$prodDir = Join-Path $env:APPDATA "com.muyuxiaoluo.life-strategy-library"
$devDir = Join-Path $env:APPDATA "com.muyuxiaoluo.life-strategy-library.dev"

# 根据同步方向确定来源与目标目录
$sourceDir = if ($Direction -eq "prod-to-dev") { $prodDir } else { $devDir }
$targetDir = if ($Direction -eq "prod-to-dev") { $devDir } else { $prodDir }
$sourceDb = Join-Path $sourceDir "mind-garden.db"
$targetDb = Join-Path $targetDir "mind-garden.db"

if (-not (Test-Path $sourceDb)) {
    Write-Error "来源数据库不存在:$sourceDb"
    exit 1
}

# 同步前确保正式版与调试版都已完全退出(包括系统托盘),避免复制正在使用中的数据库
$running = Get-Process -Name "人生攻略库", "life-strategy-library" -ErrorAction SilentlyContinue
if ($running) {
    Write-Error "检测到应用仍在运行,请先完全退出正式版与调试版(含托盘图标)后再同步。"
    exit 1
}

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

# 覆盖目标库前先留一份带时间戳的备份,误同步也能找回
if (Test-Path $targetDb) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    Copy-Item $targetDb (Join-Path $targetDir "mind-garden.before-sync-$stamp.db")
}

# 清除目标侧残留的 WAL/SHM 文件,避免与复制来的数据库不匹配
Remove-Item (Join-Path $targetDir "mind-garden.db-wal"), (Join-Path $targetDir "mind-garden.db-shm") -ErrorAction SilentlyContinue

# 复制主库;若来源存在未合并的 WAL 日志则一并复制,SQLite 打开时会自动恢复
Copy-Item $sourceDb $targetDb -Force
$sourceWal = Join-Path $sourceDir "mind-garden.db-wal"
if (Test-Path $sourceWal) {
    Copy-Item $sourceWal (Join-Path $targetDir "mind-garden.db-wal") -Force
}

Write-Host "同步完成:$($Direction -replace '-', ' -> ')"
Write-Host "  源:   $sourceDb"
Write-Host "  目标: $targetDb"
