# Windows 桌面版更新

人生攻略库从 `0.2.1` 开始支持应用内更新。`0.2.0` 没有更新器，因此只需手动运行一次 `0.2.1` 安装包；以后不必卸载，应用会覆盖升级并保留本地 SQLite 数据。

## 发布一个新版本

1. 同步修改 `sites-app/package.json`、`sites-app/src-tauri/Cargo.toml` 和 `sites-app/src-tauri/tauri.conf.json` 中的版本号。
2. 将代码提交并推送到 GitHub。
3. 在 GitHub 仓库的 Actions 页面运行“发布 Windows 桌面版”，或推送与版本一致的标签（例如 `v0.2.2`）。
4. 流程会创建正式 GitHub Release，并上传 NSIS 安装包、签名文件和 `latest.json`。
5. 已安装的客户端启动后会静默检查，也可以点击顶部的“检查更新”。

## 首次配置与密钥

- GitHub Actions 需要仓库 Secret：`TAURI_SIGNING_PRIVATE_KEY`。
- 本机私钥保存在 `C:\Users\HP\.tauri\mind-garden-updater.key`，公钥保存在同目录的 `.pub` 文件中。
- 私钥不能提交、分享或丢失。请将它额外备份到可信的本地离线介质；丢失后，已安装版本无法验证以后签出的更新。
- 当前密钥没有密码，安全性依赖 Windows 账户权限、GitHub Secret 和离线备份的访问控制。

## GitHub 仓库可见性

客户端使用公开的 GitHub Release 地址读取 `latest.json`。仓库必须允许匿名访问；若仓库保持私有，应改为由自己的服务器公开托管更新文件，不能把 GitHub Token 写入客户端。
