import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

type CaptureStatus = { enabled: boolean; instant: boolean; access: boolean; connected: boolean; notifications: boolean; instantImportance: number; lastSeenAt: number; lastCaptureAt: number; lastReminderAt: number; lastProbeToken: string; lastProbeAt: number; lastOutcome: string; error: string };
export const captureNative = {
  initialize: () => invoke<CaptureStatus>("plugin:companion-finance|initialize"),
  status: () => invoke<CaptureStatus>("plugin:companion-finance|status"),
  configure: (enabled: boolean, instant: boolean) => invoke<CaptureStatus>("plugin:companion-finance|configure", { enabled, instant }),
  openRequest: () => invoke<{ open: boolean }>("plugin:companion-finance|take_open_request"),
};

export function FinanceCaptureSettings() {
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => { try { setStatus(await captureNative.status()); } catch { setMessage("交易通知服务未连接，请更新手机应用后重试"); } }, []);
  useEffect(() => { void refresh(); const resume = () => { if (!document.hidden) void refresh(); }; const timer = setInterval(resume, 2000); document.addEventListener("visibilitychange", resume); return () => { clearInterval(timer); document.removeEventListener("visibilitychange", resume); }; }, [refresh]);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setMessage(""); try { await fn(); await refresh(); } catch { setMessage("操作未完成，请重试"); } finally { setBusy(false); } };
  return <section className="card"><h2>交易通知自动记录</h2>
    <p>只识别微信支付与招商银行 App 的交易通知，保存金额、来源与通知时间。普通聊天与通知原文不保存。未补全记录保留在本机，开启私人同步后在设备内加密同步。</p>
    <p>手机和电脑请使用同一新版应用，再开启采集。即时提示可稍后处理；每天 22:00 汇总未处理记录，省电状态可能延迟提醒。</p>
    {status && <><label className="capture-check"><input type="checkbox" disabled={busy} checked={status.enabled} onChange={e => void act(() => captureNative.configure(e.target.checked, status.instant))} />开启交易采集与晚间提醒</label>
      <label className="capture-check"><input type="checkbox" disabled={busy} checked={status.instant} onChange={e => void act(() => captureNative.configure(status.enabled, e.target.checked))} />新交易即时提示补全</label>
      <p>系统通知访问：{status.access ? "已授权" : "未授权，请到系统设置开启"}<br />接收服务：{status.connected ? "已连接" : "未连接"}<br />{status.notifications ? "补全提醒已允许" : "补全提醒未允许，采集后仍可在列表处理"}</p>
      {status.enabled && status.access && <><div className="capture-actions"><button disabled={busy} onClick={() => void act(async () => {
        let checked = await captureNative.initialize();
        setMessage("正在请求系统重新连接接收服务…");
        for (let i = 0; i < 80 && !checked.connected && checked.access && checked.enabled; i++) {
          await new Promise(resolve => setTimeout(resolve, 200));
          checked = await captureNative.status();
        }
        setStatus(checked);
        setMessage(checked.connected ? "接收服务已连接，可点击“测试提醒”检查收发。" : "系统尚未连接接收服务。请检查个人工作台的后台自启动和省电策略，返回后再试；也可到通知访问设置重新开启授权。");
      })}>重新连接接收服务</button></div>{!status.connected && <p role="status">接收服务未连接，正在请求系统恢复。若反复断开，请在手机应用设置中允许个人工作台后台自启动，并将省电策略设为“无限制”。</p>}</>}
      {status.notifications && status.instantImportance >= 0 && status.instantImportance < 4 && <p role="status">“新交易补全”通道未允许顶部提示，请到“提醒显示设置”检查通知、声音及悬浮/横幅显示。</p>}
      <div className="capture-actions"><button disabled={busy} onClick={() => void act(async () => {
        const result = await invoke<{ posted: boolean; probeToken: string }>("plugin:companion-finance|test_reminder");
        if (!result.posted) { setMessage("测试提醒被系统关闭，请在提醒显示设置中允许“新交易补全”通知。"); return; }
        setMessage("测试提醒已发出，正在检查通知接收…不会新增交易记录。");
        let checked = await captureNative.status();
        for (let i = 0; i < 40 && checked.lastProbeToken !== result.probeToken; i++) {
          await new Promise(resolve => setTimeout(resolve, 200));
          checked = await captureNative.status();
        }
        setStatus(checked);
        setMessage(checked.lastProbeToken === result.probeToken
          ? "通知收发检查通过，不会新增交易。若微信/招行通知时间仍为暂无，请在系统通知访问设置中检查是否排除了这些应用或通知类型。若无顶部提示，请检查提醒显示设置。"
          : !checked.access ? "测试提醒已发出，但系统尚未授予通知访问。请点“设置通知访问”，开启“交易通知自动记录”的“允许通知访问”，并完成系统授权确认。如果开关已开启而这里仍未授权，请反馈该系统页面。"
          : "测试提醒已发出，但尚未确认收到通知。请在“设置通知访问”中关闭再开启“交易通知自动记录”，返回后再次测试，并检查系统允许接收的应用和通知类型。");
      })}>测试提醒</button><button disabled={busy} onClick={() => void act(() => invoke("plugin:companion-finance|open_reminder_settings"))}>提醒显示设置</button></div>
      <p>最近收到微信/招行通知：{captureTime(status.lastSeenAt)}<br />最近记入交易：{captureTime(status.lastCaptureAt)}<br />最近提交即时提醒：{captureTime(status.lastReminderAt)}</p>
      {status.lastOutcome && <p>{captureOutcome(status.lastOutcome)}</p>}
      <p className="muted">“测试提醒”同时检查发送与接收，不会新增交易。诊断仅保留处理状态、时间及本次测试标记，不保存通知文字。微信付款页或应用内消息需要先出现系统通知，才能采集。</p>
      {status.error && <p role="alert">{status.error}</p>}
      <div className="capture-actions"><button disabled={busy} onClick={() => void act(() => invoke("plugin:companion-finance|open_access_settings"))}>设置通知访问</button><button disabled={busy} onClick={() => void act(() => invoke("plugin:companion-finance|request_notifications"))}>允许补全提醒</button>{status.error && <button disabled={busy} onClick={() => void act(() => captureNative.initialize())}>重试通知服务</button>}</div>
    </>}{message && <p role="alert">{message}</p>}
    <p className="muted">采集不依赖页面常开；打开应用、回到前台、保存补全或手动操作时同步到电脑。强行停止应用或关闭通知访问后会中断采集。</p>
  </section>;
}

function captureTime(value: number) { return value > 0 ? new Date(value).toLocaleString("zh-CN") : "暂无"; }
function captureOutcome(value: string) {
  return ({ before_enable: "最近处理：采集开启前的旧通知已跳过。", group_summary: "最近处理：合并通知摘要已跳过，等待具体消息。", not_recognized: "最近处理：收到来源应用通知，未识别出可记录交易；普通聊天或不支持的通知格式也会显示此状态。", saved: "最近处理：交易已记入待补全。", reminder_blocked: "最近处理：交易已记入，但提醒被系统关闭。", instant_off: "最近处理：交易已记入，新交易即时提示未开启。", duplicate: "最近处理：重复通知已跳过。", storage_error: "最近处理：交易保存失败，请查看上方提示。" } as Record<string, string>)[value] ?? "";
}
