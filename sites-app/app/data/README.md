# 本地数据架构

桌面界面只依赖 `ArticleRepository`，不会依赖网页 API、D1 或特定云数据库。

## Tauri 客户端

`SqliteArticleRepository` owns the device-local article database. It accepts the
same `execute` and `select` methods exposed by `@tauri-apps/plugin-sql`, so the
future Tauri entry point only needs to:

1. load `sqlite:mind-garden.db`;
2. create `SqliteArticleRepository` with a stable device id and bundled seed
   articles;
3. pass that repository to `DesktopWorkbench`.

The repository creates its schema lazily and stores:

- the complete article;
- a per-article version;
- the last writing device;
- `synced`, `pending`, or `conflict` state;
- soft-delete tombstones;
- the last server sync cursor.

`listPendingChanges`, `markSynced`, `getSyncCursor`, and `setSyncCursor` are the
boundary for the later cloud synchronization service.

The desktop client now also uses `getDeviceId` and `applyRemoteChanges`.
Same-version disagreements are never overwritten silently: the local edit is
preserved as a visible conflict copy before the server version is applied.

`CloudSyncClient` sends only pending changes to the private sync service and
keeps its access token in memory. Login is optional, so an unavailable server
never blocks local writing.

## 迁移规则

New schema changes must be appended as idempotent migration statements. Existing
columns must not be silently repurposed because local databases will survive app
upgrades.
