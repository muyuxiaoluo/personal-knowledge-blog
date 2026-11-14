import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useState } from "react";
import { Button } from "./DesktopControls";

type Crash = { at: number; module: string; exception: string };

const dateTime = new Intl.DateTimeFormat("zh-CN", {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});

export function DeveloperMode() {
  const [active, setActive] = useState<boolean | null>(null);
  const [crashes, setCrashes] = useState<Crash[] | null>(null);
  const [error, setError] = useState("");
  const [crashError, setCrashError] = useState("");
  const supported = isTauri() && /Windows/i.test(navigator.userAgent);

  const refresh = useCallback(async () => {
    try {
      setCrashes(await invoke<Crash[]>("developer_mode_crashes"));
      setCrashError("");
    } catch (problem) {
      setCrashError(String(problem));
    }
  }, []);

  useEffect(() => {
    if (!supported) return;
    void invoke<boolean>("developer_mode_active").then(setActive).catch((problem) => setError(String(problem)));
    void refresh();
  }, [refresh, supported]);

  return <section className="tool-section developer-mode">
    <header>
      <div>
        <h2>开发者模式</h2>
        <p>{!supported ? "适用于 Windows 桌面版" : active == null ? "正在读取状态…" : active ? "已启用 · 正在记录本次开发会话" : "未启用 · 使用「启动开发调试」进入"}</p>
      </div>
      {supported && <div className="tool-section-header-actions">
        <Button onClick={() => {
          setError("");
          void invoke("developer_mode_open_logs").catch((problem) => setError(String(problem)));
        }}>打开日志目录</Button>
      </div>}
    </header>
    {error && <p role="alert">{error}</p>}
    {supported && <>
      <p>开发会话在本机保存终端输出、前端控制台与未捕获异常、应用关键操作和退出状态。每次启动应用时会保留对应的程序和调试符号。日志可能包含调试输出里的本地信息，分享前请检查内容。</p>
      <div className="developer-mode-crashes">
        <header><h3>最近 48 小时的 Windows 崩溃记录</h3><Button size="small" variant="quiet" onClick={() => void refresh()}>刷新</Button></header>
        {crashError ? <p role="alert">{crashError}</p> : crashes == null ? <p>正在读取…</p> : crashes.length === 0 ? <p>未发现当前程序路径的崩溃记录。</p> : <ul>
          {crashes.map((crash, index) => <li key={`${crash.at}-${index}`}>
            <time dateTime={new Date(crash.at).toISOString()}>{dateTime.format(crash.at)}</time>
            {" · "}{crash.module || "未知模块"}{crash.exception && ` · 0x${crash.exception.replace(/^0x/i, "")}`}
          </li>)}
        </ul>}
      </div>
      <details>
        <summary>配置 Windows 崩溃转储</summary>
        <p>Windows 小型转储可以保留原生调用栈。可由管理员为 <code>life-strategy-library.exe</code> 单独启用，默认目录为 <code>%LOCALAPPDATA%\CrashDumps</code>。</p>
        <Button size="small" variant="quiet" onClick={() => void openUrl("https://learn.microsoft.com/zh-cn/windows/win32/wer/collecting-user-mode-dumps").catch((problem) => setError(String(problem)))}>查看 Windows 配置说明</Button>
      </details>
    </>}
  </section>;
}
