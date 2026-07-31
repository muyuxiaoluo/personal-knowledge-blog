# 人生攻略库桌面端

这是一个基于 Tauri 2 的本地优先私人知识应用，不包含网页托管或公开站点。

## 运行方式

- `npm run tauri:dev`：启动桌面开发版
- `npm run desktop:build`：检查类型并生成 Tauri 内置界面资源
- `npm test`：构建桌面界面并运行 SQLite 仓库测试
- `npm run tauri:build`：生成 Windows 安装包和自动更新产物

## 数据边界

- SQLite 是本机主数据源，断网时可完整使用。
- 登录同步是可选功能，只与私人同步服务器交换增量数据。
- 本地备份写入用户“文档/人生攻略库备份”。
- `docs/` 下的 Markdown 只作为首次安装的种子内容，不再构建或发布为网站。

## 桌面能力

- 固定三栏工作台、收集箱、本地全文检索和每日回声
- `Ctrl + Shift + Space` 全局快速记录
- Windows 系统托盘入口
- GitHub Release 签名自动更新
