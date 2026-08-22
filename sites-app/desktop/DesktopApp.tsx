import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isRegistered, register } from "@tauri-apps/plugin-global-shortcut";
import Database from "@tauri-apps/plugin-sql";
import { relaunch } from "@tauri-apps/plugin-process";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppUpdater } from "./AppUpdater";
import { DesktopWorkbench, type ThemeMode } from "./DesktopWorkbench";
import { WorkbenchIcon } from "./WorkbenchIcon";
import {
  CloudSyncClient,
  CloudSyncError,
  type LoginResult,
  type SyncResult,
} from "../app/data/cloud-sync-client";
import { initialProjectSeeds } from "../app/data/project-seeds";
import { SqliteArticleRepository } from "../app/data/sqlite-article-repository";
import { SqliteProjectRepository } from "../app/data/sqlite-project-repository";
import { SqliteWorkRepository } from "../app/data/sqlite-work-repository";
import { WorkspacePreferencesRepository } from "../app/data/workspace-preferences-repository";
import { SqliteAiRepository } from "../app/data/sqlite-ai-repository";
import { IntegrationRepository } from "../app/data/integration-repository";
import {
  readLegacyQuickLinks,
  workspaceTitle,
  type QuickLink,
} from "../app/workspace-preferences";
import seedArticles from "../app/generated/articles.json";
import type { Article } from "../app/types";
import { useConfirmDialog } from "./DesktopControls";

const defaultServerUrl = "https://mind.47-108-88-117.sslip.io";
const quickCaptureShortcut = "CommandOrControl+Shift+Space";
let shortcutInitialization: Promise<void> | null = null;

type BackupPath = {
  path: string;
};

type DesktopRuntime = {
  articleRepository: SqliteArticleRepository;
  projectRepository: SqliteProjectRepository;
  workRepository: SqliteWorkRepository;
  preferencesRepository: WorkspacePreferencesRepository;
  aiRepository: SqliteAiRepository;
  integrationRepository: IntegrationRepository;
  database: Database;
};

type TauriSqliteDatabase = Database & {
  transaction(statements: Array<{ sql: string; bindValues?: Array<string | number | null | Uint8Array> }>): Promise<void>;
};

function describeStartupError(error: unknown) {
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
  const [syncing, setSyncing] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [revision, setRevision] = useState(0);
  const [mutationRevision, setMutationRevision] = useState(0);
  const [workbenchEditing, setWorkbenchEditing] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [quickLinks, setQuickLinks] = useState<QuickLink[]>([]);
  const [notice, setNotice] = useState<SyncNotice>({
    tone: "quiet",
    text: "本地资料库准备中…",
  });
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem("life-strategy.theme-mode");
    return stored === "minimal" || stored === "immersive" ? stored : "magic";
  });
  const autoSyncTimer = useRef<number | null>(null);
  const syncInFlight = useRef(false);

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
  }, [confirm, workbenchEditing]);

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
    Database.load("sqlite:mind-garden.db")
      .then(async (database) => {
        const transactionalDatabase = database as TauriSqliteDatabase;
        transactionalDatabase.transaction = async (statements) => {
          await invoke("execute_sqlite_transaction", { statements });
        };
        const articleRepository = new SqliteArticleRepository(transactionalDatabase, {
          seedArticles: seedArticles as Article[],
        });
        const projectRepository = new SqliteProjectRepository(transactionalDatabase, {
          seedProjects: initialProjectSeeds,
        });
        const workRepository = new SqliteWorkRepository(transactionalDatabase);
        const preferencesRepository = new WorkspacePreferencesRepository(transactionalDatabase);
        const aiRepository = new SqliteAiRepository(transactionalDatabase);
        const integrationRepository = new IntegrationRepository(transactionalDatabase);
        await Promise.all([
          articleRepository.list(),
          projectRepository.list(),
          workRepository.listPlans(),
          aiRepository.cleanupExpired(),
          integrationRepository.listGitHubRepositories(),
        ]);
        const preferences = await preferencesRepository.getPreferences();
        const resolvedQuickLinks = preferences.quickLinks ?? readLegacyQuickLinks(localStorage);
        if (!preferences.quickLinks) await preferencesRepository.saveQuickLinks(resolvedQuickLinks);
        const pending = await articleRepository.listPendingChanges();
        if (!active) return;
        setRuntime({ articleRepository, projectRepository, workRepository, preferencesRepository, aiRepository, integrationRepository, database });
        setDisplayName(preferences.displayName);
        setQuickLinks(resolvedQuickLinks);
        setPendingCount(pending.length);
        setNotice({ tone: "quiet", text: "" });
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
    const title = workspaceTitle(displayName);
    document.title = title;
    if (isTauri()) void getCurrentWindow().setTitle(title).catch(() => undefined);
  }, [displayName]);

  const syncClient = useMemo(
    () =>
      runtime
        ? new CloudSyncClient(runtime.articleRepository, serverUrl)
        : null,
    [runtime, serverUrl],
  );

  const updatePendingCount = useCallback(async () => {
    if (!runtime) return;
    const pending = await runtime.articleRepository.listPendingChanges();
    setPendingCount(pending.length);
  }, [runtime]);

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
        const result = await syncClient.sync(session.accessToken);
        await updatePendingCount();
        setRevision((value) => value + 1);
        setNotice(syncMessage(result, showSuccess));
      } catch (error) {
        if (error instanceof CloudSyncError && error.code === "unauthorized") {
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
    [runtime, session, syncClient, updatePendingCount, workbenchEditing],
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
      const target = await invoke<BackupPath>("reserve_backup_path");
      await runtime.articleRepository.createBackup(target.path);
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

  function changeTheme(next: ThemeMode) {
    setThemeMode(next);
    localStorage.setItem("life-strategy.theme-mode", next);
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

      <DesktopWorkbench
        repository={runtime.articleRepository}
        projectRepository={runtime.projectRepository}
        workRepository={runtime.workRepository}
        aiRepository={runtime.aiRepository}
        integrationRepository={runtime.integrationRepository}
        displayName={displayName}
        quickLinks={quickLinks}
        dataRevision={revision}
        themeMode={themeMode}
        backingUp={backingUp}
        onThemeChange={changeTheme}
        onCreateBackup={() => void createBackup()}
        onRestoreBackup={() => void restoreLatestBackup()}
        onSaveDisplayName={async (name) => {
          await runtime.preferencesRepository.saveDisplayName(name);
          setDisplayName(name.trim().slice(0, 24));
        }}
        onSaveQuickLinks={async (links) => {
          setQuickLinks(links);
          await runtime.preferencesRepository.saveQuickLinks(links);
        }}
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

      {showAccount && (
        <div className="account-backdrop" role="presentation">
          <section
            className="account-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-title"
          >
            <button
              className="account-close"
              onClick={() => setShowAccount(false)}
              aria-label="关闭账户设置"
            >
              ×
            </button>
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
                <button
                  onClick={() => {
                    setSession(null);
                    setShowAccount(false);
                    setNotice({
                      tone: "quiet",
                      text: "已退出同步，本地内容仍可正常使用。",
                    });
                  }}
                >
                  退出同步账户
                </button>
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
                <button
                  className="account-submit"
                  disabled={syncing || !password}
                  type="submit"
                >
                  {syncing ? "正在连接…" : "登录并同步"}
                </button>
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
    text: `同步完成：上传 ${result.uploaded} 条，接收 ${result.downloaded} 条。`,
  };
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
