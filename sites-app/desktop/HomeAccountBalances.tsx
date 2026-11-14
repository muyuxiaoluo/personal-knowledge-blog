import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useId, useRef, useState, type FocusEvent } from "react";
import type { IntegrationRepository } from "../app/data/integration-repository";
import type { ModelBalance, UsageConsoleSnapshot } from "../app/integration-types";
import { BrandLogo } from "./BrandLogo";
import { Button } from "./DesktopControls";
import { WorkbenchIcon } from "./WorkbenchIcon";
import { desktopApi } from "./integrationApi";

const providers = ["deepseek", "qwen"] as const;
type Provider = typeof providers[number];
type Balances = Partial<Record<Provider, ModelBalance>>;
type Usage = Partial<Record<Provider, UsageConsoleSnapshot>>;

export function HomeAccountBalances({ repository, onOpenTools }: { repository: IntegrationRepository; onOpenTools: () => void }) {
  const [balances, setBalances] = useState<Balances>({});
  const [usage, setUsage] = useState<Usage>({});
  useEffect(() => {
    let disposed = false;
    void Promise.all(providers.map(async (provider) => {
      const [cached, cachedUsage] = await Promise.all([
        repository.getCache<ModelBalance>(`balance:${provider}`),
        repository.getCache<UsageConsoleSnapshot>(`usage:${provider}`),
      ]);
      if (!disposed) {
        if (cached) setBalances((current) => ({ ...current, [provider]: cached.value }));
        if (cachedUsage) setUsage((current) => ({ ...current, [provider]: cachedUsage.value }));
      }
      if (!isTauri() || (cached && Date.now() - new Date(cached.fetchedAt).getTime() <= 30 * 60_000)) return;
      const configured = provider === "deepseek"
        ? await desktopApi.secrets.status("deepseek_api_key").catch(() => false)
        : (await Promise.all([desktopApi.secrets.status("aliyun_access_key_id").catch(() => false), desktopApi.secrets.status("aliyun_access_key_secret").catch(() => false)])).every(Boolean);
      if (!configured) return;
      const balance = provider === "deepseek" ? await desktopApi.balances.deepseek() : await desktopApi.balances.qwen();
      await repository.saveCache(`balance:${provider}`, balance, balance.fetchedAt);
      if (!disposed) setBalances((current) => ({ ...current, [provider]: balance }));
    }).map((request) => request.catch(() => { /* Retain the last successful balance and its timestamp. */ })));
    return () => { disposed = true; };
  }, [repository]);
  return <HomeBalancePopover balances={balances} usage={usage} onOpenTools={onOpenTools} />;
}

export function HomeBalancePopover({ balances, usage, onOpenTools }: { balances: Balances; usage: Usage; onOpenTools: () => void }) {
  const id = useId();
  const entryRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const timers = useRef<{ show?: number; hide?: number }>({});
  const pinned = useRef(false);
  const [open, setOpen] = useState(false);
  const topUsage = providers.flatMap((provider) => usage[provider]?.rows ?? []).sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 3);

  function clearTimers() { window.clearTimeout(timers.current.show); window.clearTimeout(timers.current.hide); }
  function hide() { clearTimers(); pinned.current = false; panelRef.current?.hidePopover(); }
  function show() {
    clearTimers();
    const trigger = entryRef.current?.querySelector("button"), panel = panelRef.current;
    if (!trigger || !panel) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 24);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`;
    panel.style.top = `${rect.bottom + 8}px`;
    panel.style.maxHeight = `${Math.max(120, window.innerHeight - rect.bottom - 20)}px`;
    if (!panel.matches(":popover-open")) panel.showPopover();
  }
  function scheduleHide() {
    clearTimers();
    if (!pinned.current && !panelRef.current?.contains(document.activeElement) && !entryRef.current?.querySelector("button")?.matches(":focus-visible")) timers.current.hide = window.setTimeout(hide, 180);
  }
  function blur(event: FocusEvent) {
    const next = event.relatedTarget;
    if (next instanceof Node && entryRef.current?.contains(next)) return;
    scheduleHide();
  }
  useEffect(() => {
    const close = (event: Event) => { if (!(event.target instanceof Node && panelRef.current?.contains(event.target))) hide(); };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => { clearTimers(); window.removeEventListener("resize", close); window.removeEventListener("scroll", close, true); };
  }, []);

  return <div className="home-balance-entry" ref={entryRef}>
    <Button variant="secondary" size="small" aria-label="查看模型账户余额" aria-controls={id} aria-expanded={open}
      onPointerEnter={(event) => { if (event.pointerType === "mouse") { clearTimers(); timers.current.show = window.setTimeout(show, 160); } }}
      onPointerLeave={scheduleHide} onFocus={show} onBlur={blur}
      onClick={() => { if (pinned.current) hide(); else { pinned.current = true; show(); } }}
    ><WorkbenchIcon name="wealth" /><span>余额</span><span aria-hidden="true">⌄</span></Button>
    <div id={id} ref={panelRef} className="home-balance-popover" popover="auto" role="region" aria-label="模型账户余额预览"
      onToggle={(event) => { const shown = (event.nativeEvent as ToggleEvent).newState === "open"; setOpen(shown); if (!shown) { pinned.current = false; clearTimers(); } }}
      onPointerEnter={clearTimers} onPointerLeave={scheduleHide} onFocus={clearTimers} onBlur={blur}
    >
      <header><strong>模型账户余额</strong><span>{providers.length} 个账户</span></header>
      {providers.map((provider) => {
        const balance = balances[provider];
        return <article key={provider}><i><BrandLogo brand={provider} /></i><div><strong>{provider === "deepseek" ? "DeepSeek" : "Qwen / 阿里云"}</strong><small>{balance?.available ? `更新于 ${new Date(balance.fetchedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : balance?.message || "尚未配置或刷新"}</small></div><b>{balance?.available ? `${balance.currency} ${balance.amount || "0"}` : balance ? "暂不可用" : "—"}</b></article>;
      })}
      {topUsage.length > 0 && <ul>{topUsage.map((row, index) => <li key={`${row.model}-${index}`}><span>{row.model}</span><strong>{new Intl.NumberFormat("zh-CN").format(row.totalTokens)} tokens</strong></li>)}</ul>}
      <footer><Button variant="ghost" size="small" onClick={() => { hide(); onOpenTools(); }}>账户管理与用量 →</Button></footer>
    </div>
  </div>;
}
