# 餐食照片同步部署记录（2026-10-26）

用户明确授权后，已更新 `admin@47.108.88.117` 的 `/opt/mind-garden` API。产品版本保持 `2.0.0`，这次为工作区功能候选部署，未提交/推送 Git、创建标签或发布 Windows 正式安装版。

## 部署内容

- 新增 `POST /v4/private/photos/sync`，复用现有鉴权和私人配对密钥，每页最多 16 条。
- 新增照片独立密文记录、增量和回执表；旧客户端仍使用原有文字记录通道。旧服务对新接口的 404 会在客户端明确提示，保留本机照片和待同步队列。
- 仅更新 Dockerfile、package.json、README 和 src 并重建 API。服务器现有 `.env`、Compose、Caddy 配置及命名数据卷保持原样。

## 交付和回滚材料

- 部署包：`deploy-artifacts/android-mvp/sync-server-2.0.0-meal-photos-20261026.tar.gz`
- SHA-256：`81c6e26b5e5e26a32864343d714cb1c071fbadb7177df816732a3895d2224954`
- 内容已复核：Dockerfile、compose.yaml、Caddyfile、package.json、src、.env.example、README.md；无真实 .env、凭据、数据库或本地依赖。
- 源码和配置备份：`/opt/mind-garden-backups/meal-photos-20261026T120010Z/source-and-config.tar.gz`，限制访问，含原配置。
- SQLite 一致性备份：容器 `/data/deployment-backups/before-meal-photos-20261026T120010Z.sqlite3`，在线备份后完整性检查通过。
- 原 API 镜像：`mind-garden-api:before-meal-photos-20261026T120010Z`。
- 部署日志：`/opt/mind-garden-backups/meal-photos-20261026T120010Z/build-and-deploy.log`。

需要回滚时，恢复备份中的源码并使用保留的旧镜像重建 API。迁移仅新增照片表，原服务可以忽略这些表；不得直接以旧数据库覆盖部署后产生的新记录。

## 验证与限制

- 部署前 Compose 配置检查与升级包校验通过。
- 升级后 API healthy，正式 HTTPS `/v1/health` 返回正常；Caddy、hbbs、hbbr 均保持运行。
- `.env` 前后校验一致；生产数据库 `PRAGMA quick_check` 通过，用户、文章和私人记录等原有表的数量未减少。
- 照片表已创建，已有私人配对信息保留。未给生产账户绑定测试密钥，未上传测试照片。
- 使用实际部署镜像，在无外部网络、无生产数据卷的临时容器中运行 6 项服务端 HTTP 测试，全部通过，覆盖登录、旧协议兼容、账户隔离、照片配对、分页上限和明文拒绝。
- 生产真实登录冒烟使用容器保留的初始账户配置，返回 401，因而未继续该会话的同步检查。未重置密码或改变已有会话；用户当前账号的真实照片往返仍待实测。
- 首次隔离测试曾因内存数据库的默认附件目录落在只读工作目录而失败，已将测试夹具移至临时目录，随后 6 项全部通过。生产服务不受此测试目录问题影响。
