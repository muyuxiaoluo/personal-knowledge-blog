import { invoke, isTauri } from "@tauri-apps/api/core";
import { isRegistered, register } from "@tauri-apps/plugin-global-shortcut";
import Database from "@tauri-apps/plugin-sql";
import { relaunch } from "@tauri-apps/plugin-process";
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
import seedArticles from "../app/generated/articles.json";
import type { Article } from "../app/types";

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
        await Promise.all([
          articleRepository.list(),
          projectRepository.list(),
          workRepository.listPlans(),
        ]);
        const pending = await articleRepository.listPendingChanges();
        if (!active) return;
        setRuntime({ articleRepository, projectRepository, workRepository, database });
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
    [runtime, session, syncClient, updatePendingCount],
  );

  useEffect(() => {
    if (!session || !mutationRevision) return;
    if (autoSyncTimer.current) window.clearTimeout(autoSyncTimer.current);
    autoSyncTimer.current = window.setTimeout(() => {
      void syncNow(false);
    }, 1200);
    return () => {
      if (autoSyncTimer.current) window.clearTimeout(autoSyncTimer.current);
    };
  }, [mutationRevision, session, syncNow]);

  async function login(event: React.FormEvent) {
    event.preventDefault();
    if (!syncClient || !username.trim() || !password) return;
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
    if (!window.confirm(`确认恢复最近备份吗？\n\n${latest.path}\n\n当前资料库会先自动保存一个安全副本，随后应用将重启。`)) return;
    setBackingUp(true);
    setNotice({ tone: "quiet", text: "正在安全恢复本地备份…" });
    try {
      await runtime.database.close();
      await invoke("restore_backup", { sourcePath: latest.path });
      await relaunch();
    } catch (error) {
      setNotice({ tone: "warning", text: error instanceof Error ? error.message : "恢复备份失败" });
      setBackingUp(false);
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
        <span>人生攻略库</span>
        <h1>正在打开你的书桌</h1>
        <p>内容只会先保存在这台设备上。</p>
      </main>
    );
  }

  return (
    <div className="desktop-app">
      {notice.text && notice.tone !== "quiet" && <div className="floating-system-alert system-alert visible"><i className={notice.tone} /><span>{notice.text}</span></div>}

      <DesktopWorkbench
        key={revision}
        repository={runtime.articleRepository}
        projectRepository={runtime.projectRepository}
        workRepository={runtime.workRepository}
        themeMode={themeMode}
        accountDock={
          <AccountDock
            session={session}
            pendingCount={pendingCount}
            syncing={syncing}
            backingUp={backingUp}
            themeMode={themeMode}
            onTheme={changeTheme}
            onBackup={() => void createBackup()}
            onRestore={() => void restoreLatestBackup()}
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
  if (!showSuccess || (!result.uploaded && !result.downloaded)) return { tone: "quiet", text: "" };
  return {
    tone: "quiet",
    text: "",
  };
}

function AccountDock({
  session,
  pendingCount,
  syncing,
  backingUp,
  themeMode,
  onTheme,
  onBackup,
  onRestore,
  onSync,
  onAccount,
}: {
  session: LoginResult | null;
  pendingCount: number;
  syncing: boolean;
  backingUp: boolean;
  themeMode: ThemeMode;
  onTheme: (mode: ThemeMode) => void;
  onBackup: () => void;
  onRestore: () => void;
  onSync: () => void;
  onAccount: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sidebar-account-dock">
      <button className="account-dock-trigger" onClick={() => setOpen((value) => !value)} title="账户与数据">
        <i><WorkbenchIcon name="account" /></i><span><strong>{session?.username || "本地工作台"}</strong><small>{session ? pendingCount ? `${pendingCount} 条待同步` : "已连接同步" : "账户与数据"}</small></span><b>{open ? "×" : "⌃"}</b>
      </button>
      {open && <section className="account-dock-menu">
        <header><span>账户与数据</span><strong>{session ? session.username : "仅保存在本机"}</strong></header>
        <nav>
          <button disabled={backingUp} onClick={onBackup}><i>⇩</i><span><strong>{backingUp ? "正在备份" : "本地备份"}</strong><small>导出资料库副本</small></span></button>
          <button disabled={backingUp} onClick={onRestore}><i>↺</i><span><strong>恢复最近备份</strong><small>恢复前会自动保留当前资料库</small></span></button>
          <button disabled={syncing} onClick={onSync}><i>↻</i><span><strong>{session ? syncing ? "正在同步" : "立即同步" : "登录同步"}</strong><small>{session ? pendingCount ? `${pendingCount} 条本地变更` : "当前没有待同步变更" : "连接自己的服务器"}</small></span></button>
          <button onClick={onAccount}><i>◉</i><span><strong>账户设置</strong><small>云同步目前覆盖笔记；完整工作台请使用本地备份</small></span></button>
          <div className="account-update-entry"><AppUpdater /></div>
        </nav>
        <div className="theme-mode-control"><span>主题强度</span><div>{([ ["minimal", "简洁"], ["magic", "魔法"], ["immersive", "沉浸"] ] as const).map(([value, label]) => <button className={themeMode === value ? "active" : ""} key={value} onClick={() => onTheme(value)}>{label}</button>)}</div></div>
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
