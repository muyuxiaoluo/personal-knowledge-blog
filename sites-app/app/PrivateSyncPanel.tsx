import { useEffect, useState } from "react";
import { createRecoveryCode, PrivateCrypto } from "./data/private-crypto";
import type { PrivateRepository } from "./data/private-repository";
import { accountBinding, systemSecrets } from "./data/secret-store";
import { privateRequest } from "./data/private-sync-client";

export function PrivateSyncPanel({ repository, server, username, mobile = false, onSync, token }: { repository: PrivateRepository; server: string; username: string | null; mobile?: boolean; onSync: () => Promise<void>; token: () => Promise<string> }) {
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState({ enabled: false, pending: 0, conflicts: 0 });
  const [conflicts, setConflicts] = useState<Awaited<ReturnType<PrivateRepository["conflicts"]>>>([]);
  const [locals, setLocals] = useState<Record<string, string>>({});
  const refresh = async () => { setStatus(await repository.status()); const rows = await repository.conflicts(); setConflicts(rows); setLocals(Object.fromEntries(await Promise.all(rows.map(async r => [r.local_id, await repository.localDocument(r.local_id)])))); };
  useEffect(() => { void refresh(); const timer = setInterval(() => { void refresh(); }, 3000); return () => clearInterval(timer); }, [repository]);
  const act = async (fn: () => Promise<void>) => { setBusy(true); setMessage(""); try { await fn(); await refresh(); } catch { setMessage("操作未完成，请检查登录状态、原恢复码和网络后重试。"); } finally { setBusy(false); } };
  const enable = async () => {
    if (!username || !consent) return;
    const binding = await accountBinding(server, username);
    const saved = await systemSecrets.get(`private_${binding}`);
    const chosen = code.trim() || saved || recovery;
    const cipher = await PrivateCrypto.fromRecoveryCode(chosen);
    const existing = await repository.meta("key_id");
    if (existing && existing !== cipher.keyId) throw new Error("恢复码不匹配");
    const previous = await repository.meta("binding");
    if (previous && previous !== binding) throw new Error("请切回原同步账户");
    // Persist a newly generated master before creating its remote vault, so an
    // interrupted first pairing can resume with the same master after restart.
    if (!mobile && !saved && !code.trim()) await systemSecrets.set(`private_${binding}`, chosen);
    await privateRequest(server, "/v4/private/pair", { keyId: cipher.keyId, create: !mobile }, await token());
    // Store securely before enabling the upload gate. A failed store cannot enable sync.
    await systemSecrets.set(`private_${binding}`, chosen);
    await repository.enable(binding, cipher.keyId, consent);
    setCode(""); setRecovery(""); setConsent(false);
    await onSync();
  };
  return <section className="private-sync-panel">
    <h3>私人数据同步</h3>
    <p>当前{status.enabled ? "已开启" : "已关闭"} · 待同步 {status.pending} · 冲突 {status.conflicts}</p>
    <p>开启后将同步本机所有历史健康日记、餐食和手工消费。包含删除标记；不包含导入账单、健康档案、AI 报告、预算和 API Key。内容在设备内加密，服务器只保存密文。</p>
    {!username ? <p>先登录已有的个人同步账户，再选择是否开启。</p> : <>
      {!status.enabled && <>
        <label>粘贴桌面恢复码<input type="password" value={code} autoComplete="off" spellCheck={false} onChange={e => setCode(e.target.value)} /></label>
        {!mobile && !recovery && <button className="private-action" disabled={busy} onClick={() => void act(async () => {
          const binding = await accountBinding(server, username);
          const saved = await systemSecrets.get(`private_${binding}`);
          setRecovery(saved || createRecoveryCode());
        })}>首次创建 / 显示本机恢复码</button>}
        {recovery && <div><p>请立即抄录保存。恢复码相当于私人数据的钥匙，关闭后不再显示。</p><output style={{ overflowWrap: "anywhere", userSelect: "text" }}>{recovery}</output></div>}
        <label><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />我已保存恢复码，并同意同步上述历史数据</label>
        <button className="private-action" disabled={!consent || busy} onClick={() => void act(enable)}>确认开启并同步</button>
      </>}
      {status.enabled && <button className="private-action" disabled={busy} onClick={() => void act(async () => { await repository.setMeta("enabled", "0"); })}>关闭私人同步</button>}
      <p>关闭只停止后续同步；退出账户保留本机数据。恢复码遗失且所有设备密钥丢失后，服务器无法恢复内容。</p>
      {conflicts.map(c => <div key={c.local_id}><p>有一条记录在两台设备被同时修改。请选择保留的版本。</p><p>本机：{locals[c.local_id] ? conflictSummary(locals[c.local_id]) : "正在读取…"}</p><p>云端：{conflictSummary(c.document)}</p>
        <button className="private-action" disabled={busy} onClick={() => void act(async () => { await repository.resolve(c.local_id, "local"); await onSync(); })}>保留{mobile ? "手机" : "本机"}</button>
        <button className="private-action" disabled={busy} onClick={() => void act(async () => { await repository.resolve(c.local_id, "remote"); await onSync(); })}>保留云端</button>
      </div>)}
    </>}
    {message && <p role="alert">{message}</p>}
  </section>;
}

function conflictSummary(value: string) {
  const d = JSON.parse(value);
  if (!d.row) return "已删除";
  return d.kind === "finance_transactions" ? `${d.row.occurred_at} · ¥${(d.row.amount_cents / 100).toFixed(2)} · ${d.row.description}` : d.kind === "health_meals" ? `${d.key[0]} · ${d.row.description}` : `${d.key[0]} · 睡眠 ${d.row.sleep_minutes ?? "—"} 分钟 · ${d.row.steps ?? "—"} 步 · ${d.row.note}`;
}
