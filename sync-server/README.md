# 人生攻略库同步服务

这个服务只负责登录、推送和拉取，不承担桌面端的日常编辑。文章首先写入每台设备自己的 SQLite，再通过 `POST /v1/sync` 合并到服务器 SQLite。

## 服务边界

- `GET /v1/health`：健康检查
- `POST /v1/auth/login`：获取 12 小时内存访问令牌
- `POST /v1/auth/change-password`：修改密码
- `POST /v1/sync`：双向增量同步

服务器按文章版本号处理变更。相同版本出现不同内容时，不覆盖任何一方，客户端会保留“冲突副本”。

同步协议 v2 为每条本地变更附加稳定的 `changeId`，服务端会重放既有回执而不是重复写入；拉取响应通过 `hasMore` 和 `cursor` 分页。服务端只保留每篇文章最新的一条变更记录，回执保留 90 天。

## 部署

复制 `.env.example` 为 `.env`，填写随机密码和签名密钥后运行：

```sh
docker compose up -d --build
```

数据保存在 Docker 命名卷 `mind-garden_mind_data` 中。Caddy 独占 80/443 并自动为 `DOMAIN` 申请 HTTPS 证书。

`TRUST_PROXY=true` 仅适用于 API 端口没有直接暴露、所有公网请求都经过 Caddy 的部署方式。直接运行 Node 服务时应保持为 `false`，避免客户端伪造转发地址绕过登录限流。
