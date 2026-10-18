import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { mobileRuntime, type MobileRuntime } from "./runtime";
import { HealthForm, ExpenseForm, today } from "./RecordForms";
import type { HealthDailyLog } from "../app/health-types";
import type { FinanceTransaction } from "../app/finance-types";
import { CompanionAccount, PrivateRequestError, PrivateSyncClient } from "../app/data/private-sync-client";
import { systemSecrets, normalizePrivateServer } from "../app/data/secret-store";
import { PrivateSyncPanel } from "../app/PrivateSyncPanel";
type Page = "home" | "health" | "expense" | "account";
export function MobileApp() {
  const [runtime, setRuntime] = useState<MobileRuntime | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => { void mobileRuntime().then(setRuntime).catch(() => setError(true)); }, []);
  if (!runtime) return <main><h1>个人工作台</h1><p role="status">{error ? "本机资料库未能打开。请重启应用后重试。" : "正在打开本机记录…"}</p></main>;
  return <Companion runtime={runtime} />;
}
function Companion({ runtime }: { runtime: MobileRuntime }) {
  const [page, setPage] = useState<Page>("home");
  const [date, setDate] = useState(today());
  const [expense, setExpense] = useState<FinanceTransaction | null>(null);
  const [days, setDays] = useState<HealthDailyLog[]>([]);
  const [expenses, setExpenses] = useState<FinanceTransaction[]>([]);
  const [server, setServer] = useState("https://mind.47-108-88-117.sslip.io");
  const [username, setUsername] = useState<string | null>(null);
  const [status, setStatus] = useState("仅保存在本机");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(0);
  const account = useMemo(() => new CompanionAccount(server, runtime.privateRepository, systemSecrets), [server, runtime]);
  const client = useMemo(() => username ? new PrivateSyncClient(runtime.privateRepository, server, username, () => account.token(), systemSecrets) : null, [runtime, server, username, account]);
  const refresh = useCallback(async () => { setDays(await runtime.health.listDaily("", 14)); setExpenses(await runtime.finance.listManualTransactions(100)); const s = await runtime.privateRepository.status(); setPending(s.pending); }, [runtime]);
  const sync = useCallback(async () => {
    const s = await runtime.privateRepository.status();
    if (!s.enabled) { setStatus(navigator.onLine ? "私人同步未开启" : "离线 · 仅保存在本机"); return; }
    if (!navigator.onLine) { setStatus("离线"); return; }
    if (page === "health" || page === "expense") { setStatus("待同步 · 保存后自动同步"); return; }
    if (!client) { setStatus("待同步 · 请登录"); return; }
    setStatus("正在同步…");
    try { await client.sync(); const next = await runtime.privateRepository.status(); setStatus(next.conflicts ? "有冲突 · 请到账户设置处理" : next.pending ? "待同步" : "已同步"); await refresh(); }
    catch { setStatus("同步失败 · 可重试"); }
  }, [client, runtime, refresh, page]);
  useEffect(() => { void runtime.privateRepository.meta("server_url").then(v => { if (v) setServer(v); }); void refresh(); }, [runtime, refresh]);
  useEffect(() => { let active = true; void account.restore().then(() => { if (active) setUsername(account.session?.username ?? null); }).catch(() => { if (active) setStatus("离线保存可用 · 登录待恢复"); }); return () => { active = false; }; }, [account]);
  useEffect(() => {
    const restore = () => { if (!document.hidden && !account.session) void account.restore().then(() => setUsername(account.session?.username ?? null)).catch(() => setStatus("登录待恢复 · 可继续离线记录")); };
    window.addEventListener("online", restore); document.addEventListener("visibilitychange", restore);
    return () => { window.removeEventListener("online", restore); document.removeEventListener("visibilitychange", restore); };
  }, [account]);
  useEffect(() => {
    const resume = () => { if (!document.hidden) void sync(); };
    const offline = () => setStatus("离线");
    void sync(); window.addEventListener("online", resume); window.addEventListener("offline", offline); document.addEventListener("visibilitychange", resume);
    return () => { window.removeEventListener("online", resume); window.removeEventListener("offline", offline); document.removeEventListener("visibilitychange", resume); };
  }, [sync]);
  useEffect(() => { const back = () => { setPage("home"); }; window.addEventListener("popstate", back); return () => window.removeEventListener("popstate", back); }, []);
  const go = (next: Page) => { if (page === "home") history.pushState({ page: next }, ""); setPage(next); setNotice(""); window.scrollTo(0, 0); };
  const saved = async () => { setNotice("已保存在本机"); await refresh(); history.back(); void sync(); };
  return <main>
    <header><div><span className="eyebrow">PERSONAL WORKBENCH</span><h1>{page === "home" ? "随手记，慢慢来" : page === "health" ? "记录健康" : page === "expense" ? "补记消费" : "账户与私人同步"}</h1></div>{page !== "home" && <button className="text-button" onClick={() => history.back()}>返回</button>}</header>
    <div className="sync-strip" role="status"><span>{status}{pending > 0 ? ` · ${pending} 条待同步` : ""}</span><button onClick={() => void sync()}>立即同步</button></div>
    {notice && <p role="status">{notice}</p>}
    {page === "home" && <>
      <p className="intro">留下今天的一点记录。没有网络也可以。</p>
      <div className="entry-grid"><button className="entry health" onClick={() => { setDate(today()); go("health"); }}><span>☀</span><strong>记录健康</strong><small>睡眠、活动与三餐</small></button><button className="entry money" onClick={() => { setExpense(null); go("expense"); }}><span>＋</span><strong>补记消费</strong><small>银行卡、现金与其他</small></button></div>
      <h2>最近健康记录</h2>{days.length === 0 && <p className="muted">从今天开始，记一点就好。</p>}{days.map(day => <button className="record" key={day.date} onClick={() => { setDate(day.date); go("health"); }}><strong>{day.date}</strong><span>{day.sleepMinutes ? `睡眠 ${Math.floor(day.sleepMinutes / 60)} 小时 ${day.sleepMinutes % 60} 分钟` : "查看当天记录"} · {day.steps ?? "—"} 步</span></button>)}
      <h2>手工消费</h2>{expenses.length === 0 && <p className="muted">这里只显示手工补记，不显示批量账单。</p>}{expenses.map(item => <button className="record" key={item.id} onClick={() => { setExpense(item); go("expense"); }}><strong>{item.description} <b>¥{(item.amountCents / 100).toFixed(2)}</b></strong><span>{item.occurredAt.replace("T", " ").slice(0, 16)} · {item.source === "cash" ? "现金" : item.source === "custom" ? "银行卡 / 其他" : item.source === "wechat" ? "微信手工记录" : "支付宝手工记录"}</span></button>)}
      <button className="account-entry" onClick={() => go("account")}>账户与私人同步设置 →</button>
    </>}
    {page === "health" && <HealthForm repository={runtime.health} date={date} onDate={setDate} onSaved={saved} />}
    {page === "expense" && <ExpenseForm repository={runtime.finance} transaction={expense} onSaved={saved} />}
    {page === "account" && <>
      <AccountForm account={account} server={server} username={username} onServer={async value => { const v = normalizePrivateServer(value); await runtime.privateRepository.setMeta("server_url", v); setUsername(null); setServer(v); }} onLogin={setUsername} />
      <PrivateSyncPanel repository={runtime.privateRepository} server={server} username={username} mobile onSync={sync} token={() => account.token()} />
    </>}
  </main>;
}
function AccountForm({ account, server, username, onServer, onLogin }: { account: CompanionAccount; server: string; username: string | null; onServer: (s: string) => Promise<void>; onLogin: (s: string | null) => void }) {
  const [url, setUrl] = useState(server); const [name, setName] = useState(""); const [password, setPassword] = useState(""); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => setUrl(server), [server]);
  const login = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setMessage(""); const secret = password; setPassword(""); try { const s = await account.login(name, secret); onLogin(s.username); } catch (error) { setMessage(error instanceof PrivateRequestError ? error.message : "登录未完成，请重试；若持续失败，请检查系统安全存储是否可用。"); } finally { setBusy(false); } };
  return <section className="card"><h2>个人同步账户</h2><p>手机和电脑使用同一同步账户。账户由服务器首次部署时创建，没有公开注册入口；忘记密码时需由服务器管理员重置。登录不会自动开启私人数据上传。</p><label>服务器地址<input type="url" value={url} disabled={Boolean(username)} onChange={e => setUrl(e.target.value)} /></label>{url !== server && <button onClick={() => void onServer(url).catch(() => setMessage("请输入有效的 HTTPS 地址"))}>使用此服务器</button>}
    {username ? <><p>已登录：{username}</p><button disabled={busy} onClick={() => { setBusy(true); void account.logout().then(() => onLogin(null)).catch(() => setMessage("会话撤销失败，请联网后重试；本机数据已保留。")).finally(() => setBusy(false)); }}>退出账户，保留本机记录</button></> : <form onSubmit={login}><label>用户名<input value={name} autoComplete="username" onChange={e => setName(e.target.value)} required /></label><label>密码<input type="password" value={password} autoComplete="current-password" onChange={e => setPassword(e.target.value)} required /></label><button className="primary" disabled={busy || url !== server}>登录</button></form>}
    {message && <p role="alert">{message}</p>}
  </section>;
}
