import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "latest"
  | "downloading"
  | "installing"
  | "error";

type AvailableUpdate = {
  version: string;
  body?: string;
  date?: string;
};

export function AppUpdater() {
  const [currentVersion, setCurrentVersion] = useState("0.3.0");
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [available, setAvailable] = useState<AvailableUpdate | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState<number | undefined>();
  const updateRef = useRef<Update | null>(null);
  const checkInFlight = useRef(false);

  const checkForUpdates = useCallback(async (showDialog = true) => {
    if (showDialog) setDialogOpen(true);
    if (checkInFlight.current) return;

    if (!isTauri()) {
      setPhase("error");
      setErrorMessage("更新功能只在安装后的桌面应用中可用。");
      return;
    }

    checkInFlight.current = true;
    setPhase("checking");
    setErrorMessage("");

    try {
      if (updateRef.current) {
        await updateRef.current.close().catch(() => undefined);
        updateRef.current = null;
      }

      const update = await check({ timeout: 20_000 });
      if (!update) {
        setAvailable(null);
        setPhase("latest");
        return;
      }

      updateRef.current = update;
      setAvailable({
        version: update.version,
        body: update.body,
        date: update.date,
      });
      setPhase("available");
    } catch (error) {
      if (showDialog) {
        setPhase("error");
        setErrorMessage(
          error instanceof Error ? error.message : "暂时无法连接更新服务。",
        );
      } else {
        setPhase("idle");
      }
    } finally {
      checkInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;

    void getVersion().then(setCurrentVersion).catch(() => undefined);
    const timer = window.setTimeout(() => {
      void checkForUpdates(false);
    }, 3_500);

    return () => {
      window.clearTimeout(timer);
      if (updateRef.current) void updateRef.current.close();
    };
  }, [checkForUpdates]);

  async function installUpdate() {
    const update = updateRef.current;
    if (!update || phase === "downloading" || phase === "installing") return;

    setPhase("downloading");
    setDownloadedBytes(0);
    setTotalBytes(undefined);
    setErrorMessage("");

    let downloaded = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          setTotalBytes(event.data.contentLength);
          return;
        }
        if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setDownloadedBytes(downloaded);
          return;
        }
        setPhase("installing");
      });
      setPhase("installing");
      await relaunch();
    } catch (error) {
      setPhase("error");
      setErrorMessage(
        error instanceof Error ? error.message : "更新下载或安装失败。",
      );
    }
  }

  const progress = totalBytes
    ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
    : undefined;
  const busy = phase === "checking" || phase === "downloading" || phase === "installing";
  const buttonLabel =
    phase === "checking"
      ? "检查中…"
      : available
        ? `更新 v${available.version}`
        : "检查更新";

  return (
    <>
      <button
        className={available ? "update-entry has-update" : "update-entry"}
        disabled={busy}
        onClick={() => {
          if (available) {
            setDialogOpen(true);
          } else {
            void checkForUpdates(true);
          }
        }}
      >
        {buttonLabel}
      </button>

      {dialogOpen &&
        createPortal(
          <div className="update-backdrop" role="presentation">
            <section
              className="update-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="update-title"
              aria-live="polite"
            >
              <button
                className="update-close"
                disabled={phase === "downloading" || phase === "installing"}
                onClick={() => setDialogOpen(false)}
                aria-label="关闭更新窗口"
              >
                ×
              </button>
              <span>APP UPDATE</span>
              <h2 id="update-title">{updateTitle(phase)}</h2>
              <p>{updateDescription(phase, currentVersion, available, errorMessage)}</p>

              {available?.body && phase !== "latest" && (
                <div className="update-notes">
                  <strong>这次更新</strong>
                  <p>{available.body}</p>
                  {available.date && <small>{formatUpdateDate(available.date)}</small>}
                </div>
              )}

              {(phase === "downloading" || phase === "installing") && (
                <div className="update-progress">
                  <div>
                    <i style={{ width: `${progress ?? 12}%` }} />
                  </div>
                  <small>
                    {phase === "installing"
                      ? "正在安装，应用稍后会自动重启…"
                      : progress === undefined
                        ? "正在下载更新…"
                        : `已下载 ${progress}%`}
                  </small>
                </div>
              )}

              <div className="update-actions">
                {phase === "available" && (
                  <button className="update-primary" onClick={() => void installUpdate()}>
                    下载并安装
                  </button>
                )}
                {phase === "error" && (
                  <button className="update-primary" onClick={() => void checkForUpdates(true)}>
                    重新检查
                  </button>
                )}
                {(phase === "latest" || phase === "idle") && (
                  <button className="update-primary" onClick={() => setDialogOpen(false)}>
                    知道了
                  </button>
                )}
              </div>
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}

function updateTitle(phase: UpdatePhase) {
  if (phase === "checking") return "正在寻找新版本";
  if (phase === "available") return "发现新的版本";
  if (phase === "latest") return "已经是最新版";
  if (phase === "downloading") return "正在下载更新";
  if (phase === "installing") return "正在完成安装";
  if (phase === "error") return "这次没有检查成功";
  return "软件更新";
}

function updateDescription(
  phase: UpdatePhase,
  currentVersion: string,
  available: AvailableUpdate | null,
  errorMessage: string,
) {
  if (phase === "available" && available) {
    return `当前版本 v${currentVersion}，可更新到 v${available.version}。确认后才会下载。`;
  }
  if (phase === "latest") return `当前版本 v${currentVersion}，暂时没有更高版本。`;
  if (phase === "checking") return "正在从 GitHub 获取最新发布信息，请稍等。";
  if (phase === "downloading") return "下载完成后会自动校验签名并覆盖安装。";
  if (phase === "installing") return "你的本地内容和登录信息会继续保留。";
  if (phase === "error") return friendlyUpdateError(errorMessage);
  return "应用启动时会自动检查一次，也可以随时手动检查。";
}

function friendlyUpdateError(message: string) {
  if (/404|not found/i.test(message)) {
    return "还没有可用的正式发布版本，或 GitHub 仓库暂时不允许匿名访问。";
  }
  return message || "暂时无法连接更新服务，请稍后再试。";
}

function formatUpdateDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
