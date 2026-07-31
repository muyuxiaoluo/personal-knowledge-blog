import { invoke } from "@tauri-apps/api/core";
import Database from "@tauri-apps/plugin-sql";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KnowledgeWorkbench } from "../app/KnowledgeWorkbench";
import { AppUpdater } from "./AppUpdater";
import {
  CloudSyncClient,
  CloudSyncError,
  type LoginResult,
  type SyncResult,
} from "../app/data/cloud-sync-client";
import { SqliteArticleRepository } from "../app/data/sqlite-article-repository";
import seedArticles from "../app/generated/articles.json";
import type { Article } from "../app/types";

const defaultServerUrl = "https://mind.47-108-88-117.sslip.io";

type BackupPath = {
  path: string;
};

type DesktopRuntime = {
  repository: SqliteArticleRepository;
};

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
  const autoSyncTimer = useRef<number | null>(null);
  const syncInFlight = useRef(false);

  useEffect(() => {
    let active = true;
    Database.load("sqlite:mind-garden.db")
      .then(async (database) => {
        const repository = new SqliteArticleRepository(database, {
          seedArticles: seedArticles as Article[],
        });
        await repository.list();
        const pending = await repository.listPendingChanges();
        if (!active) return;
        setRuntime({ repository });
        setPendingCount(pending.length);
        setNotice({
          tone: "quiet",
          text: pending.length
            ? `${pending.length} 条内容等待同步`
            : "本地内容已经就绪",
        });
      })
      .catch((error) => {
        if (!active) return;
        setStartupError(
          error instanceof Error ? error.message : "无法打开本地资料库",
        );
      });
    return () => {
      active = false;
    };
  }, []);

  const syncClient = useMemo(
    () =>
      runtime
        ? new CloudSyncClient(runtime.repository, serverUrl)
        : null,
    [runtime, serverUrl],
  );

  const updatePendingCount = useCallback(async () => {
    if (!runtime) return;
    const pending = await runtime.repository.listPendingChanges();
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
      await runtime.repository.createBackup(target.path);
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
        <span>PRIVATE MIND GARDEN</span>
        <h1>正在打开你的书桌</h1>
        <p>内容只会先保存在这台设备上。</p>
      </main>
    );
  }

  return (
    <div className="desktop-app">
      <header className="desktop-statusbar">
        <div>
          <i className={notice.tone} />
          <span>{notice.text}</span>
        </div>
        <nav aria-label="桌面资料库">
          <button disabled={backingUp} onClick={createBackup}>
            {backingUp ? "备份中…" : "本地备份"}
          </button>
          <AppUpdater />
          {session ? (
            <>
              <span className="sync-account">{session.username}</span>
              <button
                className="sync-primary"
                disabled={syncing}
                onClick={() => void syncNow()}
              >
                {syncing
                  ? "同步中…"
                  : pendingCount
                    ? `同步 ${pendingCount}`
                    : "立即同步"}
              </button>
              <button onClick={() => setShowAccount(true)}>账户</button>
            </>
          ) : (
            <button
              className="sync-primary"
              onClick={() => setShowAccount(true)}
            >
              登录同步
            </button>
          )}
        </nav>
      </header>

      <KnowledgeWorkbench
        key={revision}
        initialArticles={seedArticles as Article[]}
        repository={runtime.repository}
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
            <span>PRIVATE SYNC</span>
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
  if (!showSuccess && !result.uploaded && !result.downloaded) {
    return { tone: "quiet", text: "本地内容已自动同步" };
  }
  return {
    tone: "success",
    text:
      result.uploaded || result.downloaded
        ? `同步完成：上传 ${result.uploaded} 条，接收 ${result.downloaded} 条。`
        : "所有内容都已同步。",
  };
}

function formatTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
