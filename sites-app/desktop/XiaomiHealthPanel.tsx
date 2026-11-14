import { useEffect, useState } from "react";
import type { HealthRepository } from "../app/data/health-repository";
import { emptyXiaomiSyncSettings, mergeXiaomiDay, type XiaomiDayState, type XiaomiQrLoginReply } from "../app/xiaomi-health";
import type { HealthDailyLog } from "../app/health-types";
import { Button } from "./DesktopControls";
import { desktopApi } from "./integrationApi";
import { syncXiaomiHealth, XIAOMI_BUSY_EVENT, XIAOMI_SYNC_EVENT, xiaomiSyncBusy } from "./xiaomi-sync";

export function XiaomiHealthPanel({ repository, date, daily, dirty, onChanged, onNotice }: {
  repository: HealthRepository; date: string; daily: HealthDailyLog; dirty: boolean; onChanged: () => void; onNotice: (message: string) => void;
}) {
  const [connected, setConnected] = useState(false);
  const [qr, setQr] = useState<XiaomiQrLoginReply | null>(null);
  const [settings, setSettings] = useState(emptyXiaomiSyncSettings);
  const [day, setDay] = useState<XiaomiDayState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(xiaomiSyncBusy);
  const [error, setError] = useState("");
  const manual = day ? mergeXiaomiDay(daily, day.latest, day, day.accountKey, day.syncedAt).protected : false;
  useEffect(() => {
    let active = true;
    const refresh = () => { void Promise.all([desktopApi.xiaomi.status(), repository.getXiaomiSettings(), repository.getXiaomiDay(date)])
      .then(([connection, preferences, source]) => { if (active) { setConnected(connection.connected); setSettings(preferences); setDay(source); } })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : String(e)); }); };
    const changedBusy = () => { setSyncBusy(xiaomiSyncBusy()); refresh(); };
    refresh();
    window.addEventListener(XIAOMI_SYNC_EVENT, refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener(XIAOMI_BUSY_EVENT, changedBusy);
    return () => { active = false; window.removeEventListener(XIAOMI_SYNC_EVENT, refresh); window.removeEventListener("focus", refresh); window.removeEventListener(XIAOMI_BUSY_EVENT, changedBusy); };
  }, [date, repository]);

  useEffect(() => {
    if (!qr) return;
    let active = true;
    let timer: number | undefined;
    const check = async () => {
      if (!active) return;
      try {
        const result = await desktopApi.xiaomi.qrPoll(qr.loginId);
        if (!active) return;
        if (result.stage === "connected") {
          setSettings(await repository.saveXiaomiSettings({ enabled: true, error: "", diagnosticJson: "" }));
          setConnected(true); setQr(null); setOpen(false); setError("");
          await sync();
        } else timer = window.setTimeout(() => void check(), 1000);
      } catch (e) {
        if (active) {
          const message = e instanceof Error ? e.message : String(e);
          setQr(null); setError(message);
          const diagnostic = await desktopApi.xiaomi.diagnostics().catch(() => []);
          await repository.saveXiaomiSettings({ error: message, diagnosticJson: JSON.stringify(diagnostic) }).catch(() => undefined);
        }
      }
    };
    void check();
    return () => { active = false; window.clearTimeout(timer); };
  }, [qr, repository]);

  async function connectQr() {
    setBusy(true); setError(""); setQr(null); setOpen(true);
    try {
      const reply = await desktopApi.xiaomi.qrStart();
      setSettings(await repository.saveXiaomiSettings({ error: "", diagnosticJson: "" }));
      setQr(reply);
    }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function sync() {
    setError("");
    try {
      const result = await syncXiaomiHealth(repository);
      if (result) onNotice(`小米数据已同步 ${result.days} 天${result.protectedDays ? `，${result.protectedDays} 天保留了手动填写的项目` : ""}${result.deferredDays ? `，${result.deferredDays} 天有并发修改，已暂缓` : ""}。`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  return <section className="health-xiaomi" aria-label="小米健康同步">
    <div className="health-xiaomi-heading"><div><strong>小米运动健康</strong><p>{connected ? "已连接 · 同步步数与主睡眠，保留手动修改" : "连接后自动填入步数、睡眠时长及起止时间"}</p></div>
      <div className="health-xiaomi-actions">{connected && <Button variant="secondary" size="small" type="button" disabled={busy || syncBusy || dirty} onClick={() => void sync()}>{syncBusy ? "正在同步…" : "立即同步"}</Button>}
        <Button variant="quiet" size="small" type="button" disabled={busy || syncBusy} onClick={() => { if (!connected) { void connectQr(); return; } setOpen(!open); setError(""); }}>{busy ? "正在获取二维码…" : connected ? open ? "收起设置" : "连接设置" : qr ? "刷新二维码" : "连接小米账号"}</Button></div></div>
    {qr?.imageDataUrl && <div className="health-xiaomi-qr"><img src={qr.imageDataUrl} width={240} height={240} alt="小米账号登录二维码" /><div><strong>用小米手机扫码登录</strong><p>打开手机“扫一扫”，扫描二维码，在手机上确认登录。</p><p>确认账号与小米运动健康一致，成功后这里会自动同步。</p><small>{qr.expiresAt ? `二维码有效至 ${new Date(qr.expiresAt).toLocaleTimeString("zh-CN")}` : "请在二维码有效期内确认"}</small></div></div>}
    {connected && <div className="health-xiaomi-meta"><span>{settings.lastSyncedAt ? `最近同步：${new Date(settings.lastSyncedAt).toLocaleString("zh-CN")}` : "等待首次同步"}</span><label><input type="checkbox" checked={settings.enabled} disabled={busy} onChange={event => { void repository.saveXiaomiSettings({ enabled: event.target.checked }).then(setSettings); }} />每晚 22:00 自动同步</label></div>}
    {day && <p className="health-xiaomi-day">{date} · 已收到小米数据{manual ? "，部分项目保留手动填写" : "，自动更新未手动修改的项目"}
      {manual && <Button variant="quiet" size="small" type="button" disabled={dirty || busy || syncBusy} onClick={() => { void repository.restoreXiaomiDay(date).then(() => { window.dispatchEvent(new Event(XIAOMI_SYNC_EVENT)); onChanged(); }).catch(e => setError(String(e))); }}>此日采用小米数据</Button>}</p>}
    {dirty && connected && <p className="health-xiaomi-hint">有未保存的编辑，自动同步会等你保存后继续。</p>}
    {(error || settings.error) && <p className="health-xiaomi-error" role="alert">{error || settings.error}</p>}
    {open && <div className="health-xiaomi-settings"><p>每天 22:00（北京时间）同步一次，补拉最近 7 天（含今天）。若当时应用未运行或断网，下次打开或联网后补同步一次。手机需先将数据同步至小米云端。</p>
      {connected && <Button variant="quiet" size="small" type="button" disabled={busy || syncBusy} onClick={() => { setBusy(true); void desktopApi.xiaomi.disconnect().then(async () => { setSettings(await repository.saveXiaomiSettings({ enabled: false, error: "" })); setConnected(false); setError(""); }).catch(e => setError(String(e))).finally(() => setBusy(false)); }}>断开连接，保留已有记录</Button>}
      <p>登录状态保存在本机系统凭据管理器，支持自动续期；失效时会提示重新连接。</p></div>}
  </section>;
}
