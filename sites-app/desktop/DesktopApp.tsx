import { Button } from "./DesktopControls";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isRegistered, register } from "@tauri-apps/plugin-global-shortcut";
import Database from "@tauri-apps/plugin-sql";
import { relaunch } from "@tauri-apps/plugin-process";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppUpdater } from "./AppUpdater";
import { DesktopThemeProvider, loadDesktopTheme, saveDesktopTheme, type ThemeId } from "./DesktopThemes";
import {
  loadDesktopFontPreset,
  saveDesktopFontPreset,
  type FontPresetId,
} from "./DesktopTypography";
import { WorkbenchIcon } from "./WorkbenchIcon";
import {
  CloudSyncClient,
  CloudSyncError,
  type LoginResult,
  type SyncResult,
} from "../app/data/cloud-sync-client";
import { initialProjectSeeds } from "../app/data/project-seeds";
import { SqliteArticleRepository } from "../app/data/sqlite-article-repository";
import {
  AttachmentRepository,
  migrateLegacyInlineImages,
} from "../app/data/attachment-repository";
import { SqliteProjectRepository } from "../app/data/sqlite-project-repository";
import { SqliteWorkRepository } from "../app/data/sqlite-work-repository";
import { WorkspacePreferencesRepository } from "../app/data/workspace-preferences-repository";
import { SqliteAiRepository } from "../app/data/sqlite-ai-repository";
import { IntegrationRepository } from "../app/data/integration-repository";
import { DashboardRepository } from "../app/data/dashboard-repository";
import { HealthRepository } from "../app/data/health-repository";
import { FinanceRepository } from "../app/data/finance-repository";
import {
  UniversalSyncRepository,
  type SyncConflict,
  type SyncItemError,
  type SyncRecycleItem,
} from "../app/data/universal-sync-repository";

import {
  addDefaultAiLinks,
  addDefaultEntertainmentLinks,
  normalizeDisplayName,
  readLegacyQuickLinks,
  workspaceTitle,
  type QuickLink,
} from "../app/workspace-preferences";
import seedArticles from "../app/generated/articles.json";
import type { Article } from "../app/types";
import {
  buildCapturedArticle,
  findExistingCapturedSource,
  type EntertainmentCaptureRequest,
} from "../app/entertainment-capture";
import { useConfirmDialog } from "./DesktopControls";

const DesktopWorkbench = lazy(async () => ({
  default: (await import("./DesktopWorkbench")).DesktopWorkbench,
}));

const defaultServerUrl = "https://mind.47-108-88-117.sslip.io";
const quickCaptureShortcut = "CommandOrControl+Shift+Space";
let shortcutInitialization: Promise<void> | null = null;

type BackupPath = {
  path: string;
};

type StoredRefreshSession = {
  serverUrl: string;
  username: string;
  refreshToken: string;
  expiresAt: string;
};

type DesktopRuntime = {
  articleRepository: SqliteArticleRepository;
  attachmentRepository: AttachmentRepository;
  projectRepository: SqliteProjectRepository;
  workRepository: SqliteWorkRepository;
  preferencesRepository: WorkspacePreferencesRepository;
  aiRepository: SqliteAiRepository;
  integrationRepository: IntegrationRepository;
  dashboardRepository: DashboardRepository;
  healthRepository: HealthRepository;
  financeRepository: FinanceRepository;
  syncRepository: UniversalSyncRepository;
  database: Database;
};

type TauriSqliteDatabase = Database & {
  transaction(statements: Array<{ sql: string; bindValues?: Array<string | number | null | Uint8Array> }>): Promise<void>;
};

type DesktopRuntimeStartup = {
  runtime: DesktopRuntime;
  activeFocusId: string | null;
  displayName: string;
  avatarDataUrl: string;
  quickLinks: QuickLink[];
  pendingCount: number;
};

let desktopRuntimeInitialization: Promise<DesktopRuntimeStartup> | null = null;
let attachmentMigration: Promise<Awaited<ReturnType<typeof migrateLegacyInlineImages>>> | null = null;

function initializeDesktopRuntime() {
  desktopRuntimeInitialization ??= Database.load("sqlite:mind-garden.db")
    .then(async (database) => {
      const transactionalDatabase = database as TauriSqliteDatabase;
      transactionalDatabase.transaction = async (statements) => {
        await invoke("execute_sqlite_transaction", { statements });
      };
      const articleRepository = new SqliteArticleRepository(transactionalDatabase, {
        seedArticles: seedArticles as Article[],
      });
      const attachmentRepository = new AttachmentRepository(transactionalDatabase);
      const projectRepository = new SqliteProjectRepository(transactionalDatabase, {
        seedProjects: initialProjectSeeds,
      });
      const workRepository = new SqliteWorkRepository(transactionalDatabase);
      const preferencesRepository = new WorkspacePreferencesRepository(transactionalDatabase);
      const aiRepository = new SqliteAiRepository(transactionalDatabase);
      const integrationRepository = new IntegrationRepository(transactionalDatabase);
      const dashboardRepository = new DashboardRepository(transactionalDatabase);
      const healthRepository = new HealthRepository(transactionalDatabase);
      const financeRepository = new FinanceRepository(transactionalDatabase);
      await Promise.all([
        articleRepository.ready(),
        attachmentRepository.initialize(),
        projectRepository.ready(),
        preferencesRepository.ready(),
        dashboardRepository.ready(),
        healthRepository.ready(),
        financeRepository.ready(),
        aiRepository.cleanupExpired(),
      ]);
      await workRepository.ready();
      const syncRepository = new UniversalSyncRepository(transactionalDatabase);
      await syncRepository.initialize();
      await attachmentRepository.cleanupAbandonedDrafts();
      const [activeFocusAtStartup, preferences, pending] = await Promise.all([
        workRepository.getActiveSession(),
        preferencesRepository.getPreferences(),
        syncRepository.getStatus(),
      ]);
      const resolvedQuickLinks = preferences.quickLinks
        ?? addDefaultAiLinks(addDefaultEntertainmentLinks(readLegacyQuickLinks(localStorage)));
      if (!preferences.quickLinks) await preferencesRepository.saveQuickLinks(resolvedQuickLinks);
      return {
        runtime: {
          articleRepository,
          attachmentRepository,
          projectRepository,
          workRepository,
          preferencesRepository,
          aiRepository,
          integrationRepository,
          dashboardRepository,
          healthRepository,
          financeRepository,
          syncRepository,
          database,
        },
        activeFocusId: activeFocusAtStartup?.id ?? null,
        displayName: preferences.displayName,
        avatarDataUrl: preferences.avatarDataUrl,
        quickLinks: resolvedQuickLinks,
        pendingCount: pending.pending,
      };
    })
    .catch((error) => {
      desktopRuntimeInitialization = null;
      throw error;
    });
  return desktopRuntimeInitialization;
}

function describeStartupError(error: unknown) {
  if (typeof error === "string" && error.trim()) return error;
  if (!(error instanceof Error)) return "无法打开本地资料库";
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) return `${error.message}：${cause.message}`;
  if (cause) return `${error.message}：${String(cause)}`;
  return error.message;
}

type SyncNotice = {
  tone: "quiet" | "success" | "warning";
  text: string;
};

export function DesktopApp() {
  const confirm = useConfirmDialog();
  const [runtime, setRuntime] = useState<DesktopRuntime | null>(null);
  const [startupError, setStartupError] = useState("");
  const [showAccount, setShowAccount] = useState(false);
  const [username, setUsername] = useState(
    () => localStorage.getItem("mind-garden.username") || "owner",
  );
  const [password, setPassword] = useState("");
  const [serverUrl, setServerUrl] = useState(
    () => localStorage.getItem("mind-garden.server-url") || defaultServerUrl,
  );
  const [session, setSession] = useState<LoginResult | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [syncCenter, setSyncCenter] = useState({ pending: 0, errors: 0, conflicts: 0, recycled: 0, cursor: "" });
  const [syncConflicts, setSyncConflicts] = useState<SyncConflict[]>([]);
  const [syncErrors, setSyncErrors] = useState<SyncItemError[]>([]);
  const [syncRecycle, setSyncRecycle] = useState<SyncRecycleItem[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [revision, setRevision] = useState(0);
  const [mutationRevision, setMutationRevision] = useState(0);
  const [workbenchEditing, setWorkbenchEditing] = useState(false);
  const [startupActiveFocusId, setStartupActiveFocusId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [avatarDataUrl, setAvatarDataUrl] = useState("");
  const [quickLinks, setQuickLinks] = useState<QuickLink[]>([]);
  const [notice, setNotice] = useState<SyncNotice>({
    tone: "quiet",
    text: "本地资料库准备中…",
  });
  const [themeId, setThemeId] = useState<ThemeId>(loadDesktopTheme);
  const [fontPresetId, setFontPresetId] = useState<FontPresetId>(loadDesktopFontPreset);
  useEffect(() => {
    // Portalled menus and confirmations must share the workspace palette.
    document.documentElement.dataset.workspaceTheme = themeId;
    return () => { delete document.documentElement.dataset.workspaceTheme; };
  }, [themeId]);
  const autoSyncTimer = useRef<number | null>(null);
  const syncInFlight = useRef(false);
  const activeCaptureRequests = useRef(new Set<string>());

  useEffect(() => {
    if (fontPresetId === "wenkai") void import("./font-wenkai.css");
    if (fontPresetId === "serif") void import("./font-serif.css");
  }, [fontPresetId]);

  useEffect(() => {
    if (notice.tone !== "success" || !notice.text) return;
    const timer = window.setTimeout(() => setNotice({ tone: "quiet", text: "" }), 3600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    void listen("request-app-quit", async () => {
      if (workbenchEditing && !await confirm({
        title: "退出前放弃未保存内容？",
        description: "当前编辑还没有结束。退出后，尚未保存的内容不会保留。",
        confirmLabel: "放弃并退出",
        tone: "warning",
      })) return;
      const activeFocus = await runtime?.workRepository.getActiveSession().catch(() => null);
      if (activeFocus) await runtime?.workRepository.stopSession(activeFocus.id).catch(() => undefined);
      void invoke("quit_app");
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [confirm, runtime, workbenchEditing]);

  useEffect(() => {
    if (!isTauri()) return;
    const appWindow = getCurrentWindow();
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    let closing = false;
    void appWindow.onCloseRequested(async (event) => {
      if (closing) return;
      event.preventDefault();
      if (workbenchEditing && !await confirm({
        title: "退出前放弃未保存内容？",
        description: "当前编辑还没有结束。退出后，尚未保存的内容不会保留。",
        confirmLabel: "放弃并退出",
        tone: "warning",
      })) return;
      const activeFocus = await runtime?.workRepository.getActiveSession().catch(() => null);
      if (activeFocus) await runtime?.workRepository.stopSession(activeFocus.id).catch(() => undefined);
      closing = true;
      await invoke("quit_app");
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [confirm, runtime, workbenchEditing]);

  useEffect(() => {
    if (!isTauri() || shortcutInitialization) return;
    shortcutInitialization = (async () => {
      if (await isRegistered(quickCaptureShortcut)) return;
      await register(quickCaptureShortcut, async (event) => {
        if (event.state !== "Pressed") return;
        await invoke("show_main_window").catch(() => undefined);
        window.dispatchEvent(new Event("mind-garden:quick-capture"));
      });
    })().catch((error) => {
      shortcutInitialization = null;
      setNotice({
        tone: "warning",
        text: error instanceof Error
          ? `全局快速记录暂不可用：${error.message}`
          : "全局快速记录暂不可用",
      });
    });
  }, []);

  useEffect(() => {
    let active = true;
    initializeDesktopRuntime()
      .then((startup) => {
        if (!active) return;
        setRuntime(startup.runtime);
        setStartupActiveFocusId(startup.activeFocusId);
        setDisplayName(startup.displayName);
        setAvatarDataUrl(startup.avatarDataUrl);
        setQuickLinks(startup.quickLinks);
        setPendingCount(startup.pendingCount);
        setNotice({ tone: "quiet", text: "" });
        attachmentMigration ??= migrateLegacyInlineImages(
          startup.runtime.articleRepository,
          startup.runtime.attachmentRepository,
          async () => { await invoke("create_backup_bundle"); },
        );
        void attachmentMigration.then((result) => {
          if (!active || (!result.migratedArticles && !result.failedArticles)) return;
          setRevision((value) => value + 1);
          setNotice({
            tone: result.failedArticles ? "warning" : "success",
            text: result.failedArticles
              ? `已迁移 ${result.migratedImages} 张旧图片；${result.failedArticles} 篇笔记需稍后处理，原文未被修改。`
              : `已安全迁移 ${result.migratedImages} 张旧图片。`,
          });
        }).catch((error) => {
          if (!active) return;
          setNotice({
            tone: "warning",
            text: error instanceof Error
              ? `旧图片迁移尚未开始：${error.message}`
              : "旧图片迁移尚未开始，升级前安全备份失败。",
          });
        });
      })
      .catch((error) => {
        if (!active) return;
        setStartupError(describeStartupError(error));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!isTauri() || !runtime) return;
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    void listen<EntertainmentCaptureRequest>("entertainment-capture-request", async ({ payload }) => {
      const requestId = payload.snapshot.requestId;
      if (!requestId || activeCaptureRequests.current.has(requestId)) return;
      activeCaptureRequests.current.add(requestId);
      let success = false;
      let message = "保存没有完成";
      try {
        if (payload.mode === "explore") {
          const articles = await runtime.articleRepository.list();
          const existing = findExistingCapturedSource(articles, payload.snapshot);
          if (existing) {
            success = true;
            message = existing.branch === "已归档"
              ? "这条内容已经在探索库的归档中"
              : "已经收集过这条内容";
          } else {
            await runtime.articleRepository.save(buildCapturedArticle(payload));
            success = true;
            message = "已经收进探索库";
          }
        } else {
          await runtime.articleRepository.save(buildCapturedArticle(payload));
          success = true;
          message = "这一刻已经放进待整理";
        }
        if (success) {
          const pending = await runtime.articleRepository.listPendingChanges();
          setPendingCount(pending.length);
          setRevision((value) => value + 1);
          setMutationRevision((value) => value + 1);
        }
      } catch (reason) {
        message = reason instanceof Error ? reason.message : "保存当前内容失败";
      } finally {
        await invoke("entertainment_capture_complete", {
          requestId,
          success,
          message,
        }).catch(() => undefined);
        activeCaptureRequests.current.delete(requestId);
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [runtime]);

  useEffect(() => {
    const title = workspaceTitle(displayName);
    document.title = title;
    if (isTauri()) void getCurrentWindow().setTitle(title).catch(() => undefined);
  }, [displayName]);

  const syncClient = useMemo(
    () =>
      runtime
        ? new CloudSyncClient(runtime.articleRepository, serverUrl, {
          universalRepository: runtime.syncRepository,
          attachmentRepository: runtime.attachmentRepository,
        })
        : null,
    [runtime, serverUrl],
  );

  const updatePendingCount = useCallback(async () => {
    if (!runtime) return;
    const [status, conflicts, errors, recycle] = await Promise.all([
      runtime.syncRepository.getStatus(),
      runtime.syncRepository.listConflicts(),
      runtime.syncRepository.listErrors(),
      runtime.syncRepository.listRecycle(),
    ]);
    setPendingCount(status.pending);
    setSyncCenter(status);
    setSyncConflicts(conflicts);
    setSyncErrors(errors);
    setSyncRecycle(recycle);
  }, [runtime]);

  useEffect(() => {
    void updatePendingCount();
  }, [updatePendingCount]);

  const storeRefreshSession = useCallback(async (loginResult: LoginResult) => {
    if (!loginResult.refreshToken || !loginResult.refreshExpiresAt) return;
    await invoke("sync_refresh_session_store", {
      session: {
        serverUrl: serverUrl.replace(/\/+$/, ""),
        username: loginResult.username,
        refreshToken: loginResult.refreshToken,
        expiresAt: loginResult.refreshExpiresAt,
      } satisfies StoredRefreshSession,
    });
  }, [serverUrl]);

  useEffect(() => {
    if (!runtime || !session) {
      runtime?.attachmentRepository.setRemoteLoader(null);
      return;
    }
    runtime.attachmentRepository.setRemoteLoader((manifest, original) => (
      runtime.attachmentRepository.downloadForSync(
        serverUrl,
        session.accessToken,
        manifest,
        original,
      ).then(() => undefined)
    ));
    return () => runtime.attachmentRepository.setRemoteLoader(null);
  }, [runtime, serverUrl, session]);

  useEffect(() => {
    if (!syncClient || session || !isTauri()) return;
    let active = true;
    void invoke<StoredRefreshSession | null>("sync_refresh_session_load")
      .then(async (stored) => {
        if (!stored || stored.serverUrl.replace(/\/+$/, "") !== serverUrl.replace(/\/+$/, "")) return;
        const refreshed = await syncClient.refresh(stored.refreshToken);
        if (!active) return;
        await storeRefreshSession(refreshed);
        setSession(refreshed);
        setUsername(refreshed.username);
        setNotice({ tone: "quiet", text: "登录状态已恢复，正在同步…" });
      })
      .catch(async (error) => {
        if (error instanceof CloudSyncError && error.code === "unauthorized") {
          await invoke("sync_refresh_session_delete").catch(() => undefined);
        }
      });
    return () => { active = false; };
  }, [serverUrl, session, storeRefreshSession, syncClient]);

  const syncNow = useCallback(
    async (showSuccess = true) => {
      if (!syncClient || !runtime || !session || syncInFlight.current) return;
      if (workbenchEditing) {
        if (showSuccess) {
          setNotice({ tone: "warning", text: "请先保存或退出当前编辑，再开始同步。" });
        }
        return;
      }
      syncInFlight.current = true;
      setSyncing(true);
      setNotice({ tone: "quiet", text: "正在安全同步…" });
      try {
        let activeSession = session;
        if (
          activeSession.refreshToken
          && new Date(activeSession.expiresAt).getTime() <= Date.now() + 60_000
        ) {
          activeSession = await syncClient.refresh(activeSession.refreshToken);
          await storeRefreshSession(activeSession);
          setSession(activeSession);
        }
        const result = await syncClient.sync(activeSession.accessToken);
        await updatePendingCount();
        setRevision((value) => value + 1);
        setNotice(syncMessage(result, showSuccess));
      } catch (error) {
        if (error instanceof CloudSyncError && error.code === "unauthorized") {
          await invoke("sync_refresh_session_delete").catch(() => undefined);
          setSession(null);
          setShowAccount(true);
        }
        setNotice({
          tone: "warning",
          text: error instanceof Error ? error.message : "同步没有完成",
        });
      } finally {
        syncInFlight.current = false;
        setSyncing(false);
      }
    },
    [runtime, session, storeRefreshSession, syncClient, updatePendingCount, workbenchEditing],
  );

  useEffect(() => {
    if (!session || !mutationRevision || workbenchEditing) return;
    if (autoSyncTimer.current) window.clearTimeout(autoSyncTimer.current);
    autoSyncTimer.current = window.setTimeout(() => {
      void syncNow(false);
    }, 1200);
    return () => {
      if (autoSyncTimer.current) window.clearTimeout(autoSyncTimer.current);
    };
  }, [mutationRevision, session, syncNow, workbenchEditing]);

  useEffect(() => {
    if (!session) return;
    void syncNow(false);
    let timer = 0;
    const schedule = () => {
      const jitter = Math.round((Math.random() - 0.5) * 60_000);
      timer = window.setTimeout(async () => {
        await syncNow(false);
        schedule();
      }, 5 * 60_000 + jitter);
    };
    const resume = () => void syncNow(false);
    schedule();
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("online", resume);
      window.removeEventListener("focus", resume);
    };
  }, [session, syncNow]);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    if (!syncClient || !username.trim() || !password) return;
    if (workbenchEditing) {
      setNotice({ tone: "warning", text: "请先保存或退出当前编辑，再登录同步。" });
      setShowAccount(false);
      return;
    }
    setSyncing(true);
    setNotice({ tone: "quiet", text: "正在登录同步账户…" });
    try {
      const result = await syncClient.login(username.trim(), password);
      await storeRefreshSession(result);
      localStorage.setItem("mind-garden.username", result.username);
      localStorage.setItem("mind-garden.server-url", serverUrl);
      setSession(result);
      setPassword("");
      setShowAccount(false);
      setNotice({ tone: "quiet", text: "登录成功，正在完成首次同步…" });
      const syncResult = await syncClient.sync(result.accessToken);
      await updatePendingCount();
      setRevision((value) => value + 1);
      setNotice(syncMessage(syncResult, true));
    } catch (error) {
      setNotice({
        tone: "warning",
        text: error instanceof Error ? error.message : "登录失败",
      });
    } finally {
      setSyncing(false);
    }
  }

  async function createBackup() {
    if (!runtime || backingUp) return;
    setBackingUp(true);
    setNotice({ tone: "quiet", text: "正在整理本地备份…" });
    try {
      const target = await invoke<BackupPath>("create_backup_bundle");
      setNotice({
        tone: "success",
        text: `备份已保存到：${target.path}`,
      });
    } catch (error) {
      setNotice({
        tone: "warning",
        text: error instanceof Error ? error.message : "备份失败",
      });
    } finally {
      setBackingUp(false);
    }
  }

  async function logout() {
    const refreshToken = session?.refreshToken;
    setSession(null);
    setShowAccount(false);
    if (refreshToken) await syncClient?.logout(refreshToken).catch(() => undefined);
    await invoke("sync_refresh_session_delete").catch(() => undefined);
    setNotice({ tone: "quiet", text: "已退出同步，本地内容仍可正常使用。" });
  }

  async function resolveSyncConflict(id: string, strategy: "local" | "remote" | "copy") {
    if (!runtime) return;
    try {
      await runtime.syncRepository.resolveConflict(id, strategy);
      await updatePendingCount();
      setRevision((value) => value + 1);
      setNotice({ tone: "success", text: strategy === "local" ? "已保留本机版本，等待重新同步。" : strategy === "copy" ? "已复制本机版本为新记录。" : "已采用云端版本。" });
    } catch (error) {
      setNotice({ tone: "warning", text: error instanceof Error ? error.message : "冲突处理失败" });
    }
  }

  async function restoreSyncRecycle(item: SyncRecycleItem) {
    if (!runtime) return;
    try {
      await runtime.syncRepository.restoreRecycled(item.entityType, item.entityId);
      await updatePendingCount();
      setRevision((value) => value + 1);
      setNotice({ tone: "success", text: "记录已从同步回收站恢复。" });
    } catch (error) {
      setNotice({ tone: "warning", text: error instanceof Error ? error.message : "恢复失败" });
    }
  }

  async function restoreLatestBackup() {
    if (!runtime || backingUp) return;
    const latest = await invoke<BackupPath | null>("latest_backup_path").catch(() => null);
    if (!latest) {
      setNotice({ tone: "warning", text: "还没有可恢复的本地备份。" });
      return;
    }
    if (!await confirm({
      title: "恢复最近一次备份？",
      description: <><p>{latest.path}</p><p>当前资料库会先自动保存一个安全副本，随后应用将重启。</p></>,
      confirmLabel: "恢复并重启",
      tone: "warning",
    })) return;
    setBackingUp(true);
    setNotice({ tone: "quiet", text: "正在安全恢复本地备份…" });
    try {
      await runtime.database.close();
      await invoke("restore_backup", { sourcePath: latest.path });
      await relaunch();
    } catch (error) {
      const message = error instanceof Error ? error.message : "恢复备份失败";
      setBackingUp(false);
      await confirm({
        title: "恢复没有完成",
        description: <><p>{message}</p><p>资料库连接已经关闭，应用将立即重启以恢复正常使用。</p></>,
        confirmLabel: "立即重启",
        cancelLabel: "关闭提示",
        tone: "warning",
      });
      await relaunch().catch(() => {
        setNotice({ tone: "warning", text: `${message}；请手动重新启动应用。` });
      });
    }
  }

  function changeTheme(next: ThemeId) {
    setThemeId(next);
    saveDesktopTheme(next);
  }

  function changeFontPreset(next: FontPresetId) {
    setFontPresetId(next);
    saveDesktopFontPreset(next);
  }

  if (startupError) {
    return (
      <main className="desktop-startup">
        <span>资料库未能打开</span>
        <h1>本地数据没有被修改</h1>
        <p>{startupError}</p>
      </main>
    );
  }

  if (!runtime) {
    return (
      <main className="desktop-startup">
        <span>个人工作台</span>
        <h1>正在打开你的书桌</h1>
        <p>内容只会先保存在这台设备上。</p>
      </main>
    );
  }

  return (
    <div className="desktop-app">
      {notice.text && notice.tone !== "quiet" && <div className="floating-system-alert system-alert visible"><i className={notice.tone} /><span>{notice.text}</span></div>}

      <Suspense fallback={<main className="desktop-startup"><span>个人工作台</span><h1>正在整理桌面</h1></main>}>
      <DesktopThemeProvider themeId={themeId}>
        <DesktopWorkbench
        repository={runtime.articleRepository}
        attachmentRepository={runtime.attachmentRepository}
        projectRepository={runtime.projectRepository}
        workRepository={runtime.workRepository}
        aiRepository={runtime.aiRepository}
        integrationRepository={runtime.integrationRepository}
        dashboardRepository={runtime.dashboardRepository}
        healthRepository={runtime.healthRepository}
        financeRepository={runtime.financeRepository}
        displayName={displayName}
        avatarDataUrl={avatarDataUrl}
        quickLinks={quickLinks}
        dataRevision={revision}
        themeId={themeId}
        fontPresetId={fontPresetId}
        backingUp={backingUp}
        onThemeChange={changeTheme}
        onFontPresetChange={changeFontPreset}
        onCreateBackup={() => void createBackup()}
        onRestoreBackup={() => void restoreLatestBackup()}
        onSaveDisplayName={async (name) => {
          await runtime.preferencesRepository.saveDisplayName(name);
          setDisplayName(normalizeDisplayName(name));
        }}
        onSaveAvatarDataUrl={async (dataUrl) => {
          await runtime.preferencesRepository.saveAvatarDataUrl(dataUrl);
          setAvatarDataUrl(dataUrl);
        }}
        onSaveQuickLinks={async (links) => {
          setQuickLinks(links);
          await runtime.preferencesRepository.saveQuickLinks(links);
        }}
        startupActiveFocusId={startupActiveFocusId}
        onEditingStateChange={setWorkbenchEditing}
        accountDock={
          <AccountDock
            session={session}
            pendingCount={pendingCount}
            syncing={syncing}
            onSync={() => session ? void syncNow() : setShowAccount(true)}
            onAccount={() => setShowAccount(true)}
          />
        }
        onRepositoryChange={() => {
          void updatePendingCount();
          setMutationRevision((value) => value + 1);
        }}
        />
      </DesktopThemeProvider>
      </Suspense>

      {showAccount && (
        <div className="account-backdrop" role="presentation">
          <section
            className="account-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-title"
          >
            <Button variant="secondary" size="small" iconOnly type="button"
              className="account-close"
              onClick={() => setShowAccount(false)}
              aria-label="关闭账户设置"
            >
              ×
            </Button>
            <span>个人同步</span>
            <h2 id="account-title">
              {session ? "同步账户" : "登录后同步"}
            </h2>
            <p>
              不登录也可以继续写。登录只会把本地变更推送到你的服务器，并拉取其他设备的内容。
            </p>
            {session ? (
              <div className="account-current">
                <strong>{session.username}</strong>
                <small>本次登录有效至 {formatTime(session.expiresAt)}</small>
                <Button variant="secondary" type="button"
                  onClick={() => void logout()}
                >
                  退出同步账户
                </Button>
                <details className="sync-center" open={Boolean(syncCenter.conflicts || syncCenter.errors)}>
                  <summary><strong>同步中心</strong><span>{syncCenter.pending} 待同步 · {syncCenter.conflicts} 冲突 · {syncCenter.errors} 错误 · {syncCenter.recycled} 回收站</span></summary>
                  <div className="sync-center-body">
                    <p>后台失败不会中断本地编辑；附件会先同步展示版，需要原图时再按需读取。</p>
                    {syncConflicts.map((item) => (
                      <article key={item.id} className="sync-center-item">
                        <div><strong>{syncEntityLabel(item.localPayload, item.entityId)}</strong><small>{item.entityType} · 本机与云端都修改过</small></div>
                        <div><Button variant="secondary" type="button" onClick={() => void resolveSyncConflict(item.id, "remote")}>用云端</Button><Button variant="secondary" type="button" onClick={() => void resolveSyncConflict(item.id, "local")}>用本机</Button><Button variant="secondary" type="button" onClick={() => void resolveSyncConflict(item.id, "copy")}>复制本机</Button></div>
                      </article>
                    ))}
                    {syncErrors.map((item) => (
                      <article key={`${item.entityType}:${item.entityId}`} className="sync-center-item error">
                        <div><strong>{item.entityId}</strong><small>{item.error}</small></div>
                        <Button variant="secondary" type="button" onClick={async () => { await runtime?.syncRepository.retryError(item.entityType, item.entityId); await updatePendingCount(); }}>重试</Button>
                      </article>
                    ))}
                    {syncRecycle.slice(0, 20).map((item) => (
                      <article key={`${item.entityType}:${item.entityId}`} className="sync-center-item recycled">
                        <div><strong>{syncEntityLabel(item.payload, item.entityId)}</strong><small>保留至 {formatTime(item.purgeAfter)}</small></div>
                        <Button variant="secondary" type="button" onClick={() => void restoreSyncRecycle(item)}>恢复</Button>
                      </article>
                    ))}
                    {!syncCenter.pending && !syncCenter.conflicts && !syncCenter.errors && !syncCenter.recycled && <p>当前没有待处理项目。</p>}
                  </div>
                </details>
              </div>
            ) : (
              <form onSubmit={login}>
                <label>
                  <span>账户</span>
                  <input
                    autoFocus
                    autoComplete="username"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                  />
                </label>
                <label>
                  <span>密码</span>
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
                <details>
                  <summary>服务器地址</summary>
                  <input
                    type="url"
                    value={serverUrl}
                    onChange={(event) => setServerUrl(event.target.value)}
                  />
                </details>
                <Button variant="primary"
                  className="account-submit"
                  disabled={syncing || !password}
                  type="submit"
                >
                  {syncing ? "正在连接…" : "登录并同步"}
                </Button>
              </form>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function syncMessage(
  result: SyncResult,
  showSuccess: boolean,
): SyncNotice {
  if (result.limited) {
    return {
      tone: "warning",
      text: "服务器暂不支持完整工作台同步，已回退到 v2；附件与其他工作台数据仍安全保留在本机。",
    };
  }
  if (result.conflicts) {
    return {
      tone: "warning",
      text: `同步完成，并保留了 ${result.conflicts} 条冲突副本。`,
    };
  }
  if (!showSuccess) return { tone: "quiet", text: "" };
  if (!result.uploaded && !result.downloaded) {
    return { tone: "success", text: "同步完成，当前已经是最新状态。" };
  }
  return {
    tone: "success",
    text: `同步完成：上传 ${result.uploaded} 条，接收 ${result.downloaded} 条${result.attachmentUploads || result.attachmentDownloads ? `，附件上传 ${result.attachmentUploads ?? 0} 个、下载 ${result.attachmentDownloads ?? 0} 个` : ""}。`,
  };
}

function syncEntityLabel(payload: Record<string, unknown>, fallback: string) {
  for (const key of ["title", "label", "primary_outcome", "value"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 80);
  }
  return fallback;
}

function AccountDock({
  session,
  pendingCount,
  syncing,
  onSync,
  onAccount,
}: {
  session: LoginResult | null;
  pendingCount: number;
  syncing: boolean;
  onSync: () => void;
  onAccount: () => void;
}) {
  const [open, setOpen] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    /**
     * 更新弹窗（.update-backdrop）通过 portal 渲染在 document.body 下，不在菜单节点内。
     * 若弹窗打开期间关闭菜单，AppUpdater 会随菜单一起被卸载，导致弹窗立即消失、
     * 无法点击"下载并安装"（pointerdown 先于 click 卸载按钮），因此此时忽略外部点击。
     */
    function closeOutside(event: PointerEvent) {
      if (document.querySelector(".update-backdrop")) return;
      if (!dockRef.current?.contains(event.target as Node)) setOpen(false);
    }
    /** Escape 关闭菜单；更新弹窗打开期间同样忽略，避免弹窗被一并卸载。 */
    function closeOnEscape(event: KeyboardEvent) {
      if (document.querySelector(".update-backdrop")) return;
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="sidebar-account-dock" ref={dockRef}>
      <button className="account-dock-trigger" onClick={() => setOpen((value) => !value)} title="账户与更新">
        <i><WorkbenchIcon name="account" /></i><span><strong>{session?.username || "本地工作台"}</strong><small>{session ? pendingCount ? `${pendingCount} 条待同步` : "已连接同步" : "账户与更新"}</small></span><b>{open ? "×" : "⌃"}</b>
      </button>
      {open && <section className="account-dock-menu">
        <header><span>账户与更新</span><strong>{session ? session.username : "仅保存在本机"}</strong></header>
        <nav>
          <button disabled={syncing} onClick={onSync}><i>↻</i><span><strong>{session ? syncing ? "正在同步" : "立即同步" : "登录同步"}</strong><small>{session ? pendingCount ? `${pendingCount} 条本地变更` : "当前没有待同步变更" : "连接自己的服务器"}</small></span></button>
          <button onClick={onAccount}><i>◉</i><span><strong>账户设置</strong><small>管理登录状态与同步服务器</small></span></button>
          <div className="account-update-entry"><AppUpdater /></div>
        </nav>
      </section>}
    </div>
  );
}

function formatTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
