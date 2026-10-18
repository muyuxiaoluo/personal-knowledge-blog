# 私人同步 v4 部署记录（2026-09-08）

已按授权更新 `admin@47.108.88.117` 的 `/opt/mind-garden` 同步 API。此为当前工作区的 v4 服务端部署，包内产品版本仍为 1.0.0；未创建 Git 标签、GitHub Release 或发布新桌面安装包。

## 交付与回滚材料

- 部署包：`deploy-artifacts/android-mvp/private-sync-v4-candidate.tar.gz`
- 包 SHA-256：`b416c3695199af1686343f01a1298d30b8b1811b31f8af5e3a0c4a28e81709c5`
- 服务器源码与配置备份：`/opt/mind-garden-backups/private-v4-20260908T095729Z/source-and-config.tar.gz`（限制访问，含原 .env）
- SQLite 一致性备份：容器 `/data/deployment-backups/before-private-v4-1788861450158.sqlite3`
- 原 API 镜像：`mind-garden-api:before-private-v4-20260908T095729Z`

仅更新 Dockerfile、package.json、src 和 README，并重建 API；保留原 .env、Compose、Caddy 配置和命名数据卷。回滚应恢复备份源码并重建 API，或使用保留镜像；数据库备份不应直接覆盖部署后产生的新数据。此次迁移仅新增私人同步表，旧服务代码可忽略这些表。

## 验证

- API 为 healthy；正式 HTTPS `/v1/health`、`/v3/health` 正常。
- 正式账户 HTTPS 登录成功；v3 使用最大安全游标进行空增量检查，未拉取历史正文，也未写入客户端游标。测试会话已撤销。
- `/v4/private/pair` 的 `create:false` 校验请求到达新接口并返回 400，符合账户尚未配对时的预期；未创建正式账户的密钥绑定。
- 四张私人同步表存在；线上 private-sync.mjs 的 SHA-256 与本地相同。
- 使用部署镜像运行 5 项服务端测试，全部通过。测试容器不挂载生产数据、禁用外部网络，数据库仅位于临时目录。
- .env 校验值保持一致；原业务表记录数量与部署前备份一致。Caddy、RustDesk hbbs/hbbr 保持运行。

生产临时测试账户创建及从正式账户起始游标读取历史的两项检查被自动审批拒绝，均未执行；已采用隔离数据库测试和无历史记录的空增量检查。真实手机与桌面的生产配对、加密记录往返尚未验证，需要用户在桌面主动确认历史范围、保存恢复码并启用私人同步，再在手机粘贴同一恢复码。

健康与财富主密钥、恢复码及业务正文均未用于本次生产探测。之前已重置的同步密码继续有效。
