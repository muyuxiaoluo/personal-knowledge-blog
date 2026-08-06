# 人生攻略库桌面端使用与运维

## 现在的数据流

```text
写作与阅读
  ↓
当前设备的 mind-garden.db
  ↓ 登录后增量同步
私人服务器的同步 SQLite
  ↓
其他设备登录后拉取
```

本地 SQLite 是日常使用的数据源。服务器不可用或未登录时，记录、编辑、回看、花园和实验室仍然可以正常使用。

## Windows 使用

1. 运行 `人生攻略库_0.2.0_x64-setup.exe`。
2. 第一次打开时，程序会创建本地资料库并导入仓库里已有的文章。
3. 可以直接离线使用；需要多设备同步时再点击顶部的“登录同步”。
4. 首次部署生成的账户是 `owner`，初始密码保存在本项目被忽略提交的 `sync-server/.env` 中。
5. 初始密码可以稍后通过同步服务的密码接口修改；当前桌面版不会保存登录密码。

访问令牌只保存在本次运行的内存中。关闭软件后需要重新登录，但本地内容不受影响。

## 同步规则

- 新增、编辑和删除都会先写入本机。
- 登录状态下，变更会在短暂等待后自动同步，也可以手动点击“立即同步”。
- 每篇文章都有版本号和写入设备标识。
- 两台设备从同一版本分别修改时，服务端不会静默覆盖；桌面端会留下标题带“冲突副本”的本地版本。
- 删除使用软删除墓碑，以便其他设备也能正确收到删除操作。

## 本地备份

点击顶部“本地备份”，程序会用 SQLite 的一致性快照能力生成完整数据库副本。

Windows 默认位置：

```text
文档\人生攻略库备份\
```

建议在重要整理完成后手动备份一次，也可以再把这个目录交给系统自己的文件历史记录或网盘备份。

## 服务器部署

同步服务源码位于 `sync-server`，使用独立的 Compose 项目名 `mind-garden`。它只创建自己的 API、Caddy 和三个命名卷，不会管理、重启或停止 RustDesk 容器。

服务入口：

```text
https://mind.47-108-88-117.sslip.io
```

部署命令：

```sh
mkdir -p /opt/mind-garden
tar -xzf /home/admin/mind-garden-sync-server.tar.gz -C /opt/mind-garden
cd /opt/mind-garden
sudo docker compose config
sudo docker compose up -d --build
```

验证：

```sh
curl https://mind.47-108-88-117.sslip.io/v1/health
sudo docker compose ps
sudo docker ps --filter name=hbbs --filter name=hbbr
```

最后一条命令用于确认 RustDesk 的 `hbbs` 和 `hbbr` 仍在运行。

## 更新与回滚

更新同步服务前，先把新的部署包上传到 `/home/admin`，解压到原目录并运行：

```sh
cd /opt/mind-garden
sudo docker compose up -d --build
```

文章数据在 `mind-garden_mind_data` 命名卷中，不随容器重建而删除。不要执行带 `-v` 的 `docker compose down`。

## 开发验证

桌面前端：

```sh
cd sites-app
npm run desktop:build
```

Windows 安装包：

```sh
cd sites-app
npm run tauri:build
```

同步服务：

```sh
cd sync-server
npm test
```
