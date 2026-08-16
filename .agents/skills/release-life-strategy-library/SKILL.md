---
name: release-life-strategy-library
description: 为人生攻略库仓库准备、检查和执行版本发布。用于用户要求分析发布状态、确定下一版本、同步版本号与更新日志、运行发布前检查、提交并推送 main、创建并推送 Git 标签、观察 GitHub Actions/Release、发布 Windows Tauri 桌面端、部署 sync-server、验证自动更新或制定回滚方案时。不要用于普通开发提交或与本仓库无关的发布。
---

# 发布人生攻略库

## 基本原则

- 先确认任务是“只分析/准备”还是“实际发布”。只分析或准备时保持外部系统只读。
- 将提交、推送、创建标签、创建 Release、上传部署包和操作服务器视为独立的外部写操作；仅在用户明确要求执行对应阶段后进行。
- 保留工作区中已有的用户修改，只暂存本次确认过的文件。不要用破坏性 Git 命令清理工作区。
- 以仓库当下的配置为准。先读取 [references/release-map.md](references/release-map.md)，再核对其中列出的源文件，避免依赖可能过期的快照。
- 统一使用不带 `v` 的应用版本（如 `0.5.0`）和带 `v` 的 Git 标签（如 `v0.5.0`）。
- 不提交 `.env`、签名私钥、访问令牌、数据库或构建产物。
- 不执行 `docker compose down -v`，也不删除 `mind-garden_mind_data`。

## 1. 确定发布范围

将改动分为以下范围，并向用户报告判断依据：

- **仅桌面端**：只改 `sites-app`、桌面打包或桌面更新逻辑。
- **仅同步服务**：只改 `sync-server`，不需要新的桌面安装包。
- **联合发布**：同时改桌面端和同步服务，或变更同步接口、鉴权、数据格式、游标/冲突规则。

联合发布时先检查新旧客户端与新旧服务端的交叉兼容性。若服务端向后兼容，通常先部署服务端并验证，再发布桌面端；若不兼容，停止并给出迁移、维护窗口或分阶段兼容方案，不直接发布。

## 2. 审计当前状态

在仓库根目录执行只读检查：

```powershell
git status --short --branch
git diff --stat
git diff --check
git log --oneline --decorate -10
git tag --sort=-version:refname
git rev-list --left-right --count main...origin/main
```

同时核对：

- `.github/workflows/quality.yml` 与 `.github/workflows/release-windows.yml`；
- `CHANGELOG.md` 的“未发布”内容；
- 桌面端、Rust、同步服务的版本来源；
- `docs/desktop-updates.md` 与 `docs/software-guide.md`；
- GitHub 上目标提交的质量检查、目标标签和同名 Release 是否已存在。

运行只读预检；准备阶段允许工作区尚未提交：

```powershell
pwsh -NoProfile -File .agents/skills/release-life-strategy-library/scripts/release-preflight.ps1 -Stage Prepare
```

## 3. 确定并写入版本

根据语义化版本提出版本号，并让用户确认：

- `patch`：向后兼容的问题修复；
- `minor`：向后兼容的新功能或协议扩展；
- `major`：不兼容变化。

确认版本后同步更新 `references/release-map.md` 中列出的全部版本来源。使用现有包管理命令更新 JSON 及锁文件；使用小范围补丁更新 Rust、Tauri、界面回退版本与更新日志。不要只改旧文档提到的三个文件。

将 `CHANGELOG.md` 的“未发布”条目整理为 `## vX.Y.Z — YYYY-MM-DD`。描述用户可感知的变化、兼容性和必要的升级顺序；可以在顶部重新保留空的“未发布”节。

完成后运行：

```powershell
pwsh -NoProfile -File .agents/skills/release-life-strategy-library/scripts/release-preflight.ps1 -ExpectedVersion X.Y.Z -Stage Prepare
npm run check
```

若改动涉及 Rust 后端，再运行：

```powershell
Push-Location sites-app/src-tauri
cargo fmt --check
cargo test
Pop-Location
```

报告所有检查结果。失败时不要提交发布标签。

## 4. 提交并推送 main

再次审查差异和暂存范围，只添加已确认的源文件、测试、工作流、更新日志和本 Skill。不要使用笼统的全仓库暂存来掩盖未知文件。

建议发布提交信息：

```text
Release life strategy library vX.Y.Z
```

提交后推送 `main`，等待该提交的“质量检查”工作流成功。不要在质量工作流仍排队、运行或失败时创建版本标签。若远端没有质量工作流，至少保留本地 `npm run check`、`cargo fmt --check` 和 `cargo test` 的成功证据，并明确提示保护缺口。

## 5. 发布同步服务（适用时）

先生成只包含 `sync-server` 部署必需文件的压缩包，明确排除 `.env`、数据库和本地依赖，并列出压缩包内容复核。使用带版本号的文件名保留回滚材料。

上传和服务器操作前再次确认目标主机、目录和版本。遵循 `docs/software-guide.md` 的现有 Compose 部署方式：保留服务器现有 `.env` 和命名卷，先验证 Compose 配置，再重建服务。

部署后至少验证：

```sh
curl -fsS https://mind.47-108-88-117.sslip.io/v1/health
sudo docker compose ps
sudo docker ps --filter name=hbbs --filter name=hbbr
```

联合发布时还要运行一次真实的登录与同步冒烟测试。若失败，停止桌面端发布；使用上一版本源码重新构建服务。数据库发生不兼容迁移时，不声称代码回滚足够，必须使用发布前备份或专门迁移方案。

## 6. 创建标签并触发桌面发布

同步远端状态，确认待发布提交就是已通过质量检查的 `origin/main`。运行严格预检：

```powershell
pwsh -NoProfile -File .agents/skills/release-life-strategy-library/scripts/release-preflight.ps1 -ExpectedVersion X.Y.Z -Stage Tag
```

预检通过且用户明确授权后，创建注释标签并单独推送：

```powershell
git tag -a vX.Y.Z -m "人生攻略库 vX.Y.Z"
git push origin vX.Y.Z
```

推荐使用标签触发正式发布，便于把版本、提交和构建一一对应。手动运行“发布 Windows 桌面版”只作为明确选择的备选；运行前核对所选 ref 和同名标签/Release 不存在，避免从错误提交发布。

## 7. 观察与验证

等待“发布 Windows 桌面版”结束，不要只看到工作流启动就宣告成功。验证：

1. GitHub Actions 任务成功；
2. GitHub Release `vX.Y.Z` 为正式发布而非草稿/预发布；
3. Release 含 NSIS 安装包、更新签名和 `latest.json`；
4. `latest.json` 可匿名访问且版本为 `X.Y.Z`；
5. 从上一正式版本执行“检查更新”，能下载、校验、安装、重启；
6. 本地 SQLite 数据仍在，关键桌面流程和云同步冒烟通过。

最终报告提交 SHA、标签、Actions/Release 链接、产物、验证结果、同步服务部署状态以及任何未验证项。

## 8. 失败与回滚

- **标签尚未推送**：修复代码或版本信息，重新测试后再提交；不要发布失败提交。
- **标签已推送但 Release 未生成**：先查 Actions 日志和 Secret/权限；同一提交可重跑。不要移动已公开标签到另一提交。
- **错误版本已经公开**：撤下有问题的 Release 产物并发布更高的修复版本；不要让客户端看到版本倒退。
- **桌面端有回归**：修复后发布更高补丁版本。自动更新渠道不应复用或覆盖旧标签。
- **同步服务有回归**：恢复上一版本源码并重新构建，保留命名卷。先判断数据库迁移是否可逆。

任何回滚都要明确说明已撤回什么、用户是否已可能安装、数据是否需要恢复，以及下一版本号。
