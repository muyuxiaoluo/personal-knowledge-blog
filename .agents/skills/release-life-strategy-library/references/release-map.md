# 发布机制地图

> 本文件记录 2026-08-16 的仓库快照。每次发布前必须重新读取源文件；若配置变化，以源文件为准并更新本文件。

## 发布面

### Windows 桌面端

- 工作流：`.github/workflows/release-windows.yml`
- 触发：手动 `workflow_dispatch`，或推送匹配 `v*` 的标签
- 构建环境：`windows-latest`、Node.js 22、Rust stable
- 当前本地流程：`npm ci` → `npm test` → `tauri-apps/tauri-action@v1`
- 发布权限：`contents: write` 与自动提供的 `GITHUB_TOKEN`
- 更新签名：仓库 Secret `TAURI_SIGNING_PRIVATE_KEY`
- 产物：NSIS 安装包、签名文件、`latest.json`、GitHub Release
- 更新入口：`sites-app/src-tauri/tauri.conf.json` 的 GitHub Releases `latest.json`
- 客户端验证公钥：同一配置文件的 `plugins.updater.pubkey`

标签推送是推荐入口。工作流以应用版本替换 `v__VERSION__`，创建正式 Release，并生成自动更新元数据。

### 质量检查

- 工作流：`.github/workflows/quality.yml`
- 触发：所有 push 和 pull request
- 桌面任务：安装依赖、TypeScript/前端构建与测试、`cargo fmt --check`、`cargo test`
- 同步服务任务：Node.js 24 下运行 `npm test`

截至快照时间，`quality.yml` 仍是本地未提交文件，修改后的发布工作流也尚未推送。因此它们只有在被纳入提交并推送后才会保护远端发布；旧的 `v0.4.0` 云端构建不包含新增的桌面测试步骤。

### 同步服务

- 源码：`sync-server/`
- 容器配置：`sync-server/Dockerfile`、`sync-server/compose.yaml`、`sync-server/Caddyfile`
- 生产说明：`docs/software-guide.md`
- 健康检查：`GET /v1/health`
- 持久数据：Docker 命名卷 `mind-garden_mind_data`

仓库当前没有同步服务的 GitHub Actions 部署流程。代码推送不会自动更新服务器；必须单独打包、上传、运行 `docker compose config` 与 `docker compose up -d --build`，然后进行健康和同步验证。

## 统一版本来源

本项目当前将桌面端与同步服务作为统一产品版本。发布时让以下位置全部等于 `X.Y.Z`：

1. `package.json`
2. `package-lock.json` 的顶层版本和根包版本
3. `sites-app/package.json`
4. `sites-app/package-lock.json` 的顶层版本和根包版本
5. `sites-app/src-tauri/Cargo.toml` 的 `[package].version`
6. `sites-app/src-tauri/Cargo.lock` 中 `life-strategy-library` 包的版本
7. `sites-app/src-tauri/tauri.conf.json`
8. `sites-app/desktop/AppUpdater.tsx` 的初始回退版本
9. `sync-server/package.json`
10. `CHANGELOG.md` 的正式版本标题

不要误改锁文件中属于第三方依赖的同号版本。

可使用下列命令更新 npm 管理的版本与锁文件，不创建 Git 标签：

```powershell
npm version X.Y.Z --no-git-tag-version
npm --prefix sites-app version X.Y.Z --no-git-tag-version
npm --prefix sync-server version X.Y.Z --no-git-tag-version
```

`sync-server` 当前没有 `package-lock.json`。Rust/Tauri/界面回退版本与更新日志使用小范围补丁更新；随后由 Cargo 命令刷新并验证 `Cargo.lock`。

## 当前基线

- 本地分支：`main`
- 本地 `main` 与 `origin/main`：快照时一致
- 最新提交和标签：`bfe77c5` / `v0.4.0`
- 最新已核验的云端桌面发布工作流：`v0.4.0`，2026-08-13 成功
- 当前工作区：有大量尚未提交的桌面端、同步服务、测试、工作流与更新日志改动
- `CHANGELOG.md`：已有“未发布”内容

根据当前未发布内容，`v0.5.0` 是合理候选，因为包含向后兼容的同步协议扩展和行为增强；这只是建议，发布前仍需用户确认。

## 兼容性与顺序

快照中的同步协议 v2 保持双向兼容：

- 新服务端接受没有 `changeId` 的旧客户端请求；
- 新客户端接受没有 `protocolVersion`/`hasMore` 的旧服务端响应。

因此这批改动可先部署新服务端并完成验证，再发布桌面端。以后不可沿用该结论，必须重新检查请求校验、响应解析、认证与数据库迁移。

## 密钥和公开访问

- GitHub Actions 必须能读取 `TAURI_SIGNING_PRIVATE_KEY`。
- 私钥不得进入仓库、日志或发布包；公钥必须与客户端配置一致。
- `latest.json` 使用公开 GitHub Release 地址，必须允许客户端匿名读取。
- 当前仓库说明记载本地私钥位于 `C:\Users\HP\.tauri\mind-garden-updater.key`；只检查文件是否存在，不输出内容。
- 同步服务 `.env` 只保留在本地/服务器，部署包仅包含 `.env.example`。

## 同步服务部署包

部署包只应包含：

```text
Dockerfile
compose.yaml
Caddyfile
package.json
src/
.env.example
README.md
```

将包写入被忽略的 `deploy-artifacts/`，使用带版本号的名称，并在上传前列出内容确认没有 `.env`、数据库、`node_modules` 或其他本地文件。
