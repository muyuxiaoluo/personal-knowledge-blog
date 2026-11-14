import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { matchingAiKeywords, prioritizeAiBriefItems } from "../app/dashboard-helpers";
import type { AiBriefItem, AiBriefSnapshot } from "../app/dashboard-types";
import { Button } from "./DesktopControls";

type NewsFilter = "all" | "followed";
type Headline = { item: AiBriefItem; matches: string[] };
type NewsActions = {
  savedIds: Set<string>;
  onOpenExternal: (url: string) => Promise<void>;
  onSave: (item: AiBriefItem) => Promise<void>;
};

export function HomeAiHighlights({ snapshot, keywords, busy, error, onRefresh, sourceStatus, ...actions }: NewsActions & {
  snapshot: AiBriefSnapshot | null;
  keywords: string[];
  busy: boolean;
  error: string;
  onRefresh: () => void;
  sourceStatus: ReactNode;
}) {
  const [filter, setFilter] = useState<NewsFilter | null>(null);
  const headlines = useMemo(() => prioritizeAiBriefItems(snapshot?.items ?? [], keywords).map((item) => ({ item, matches: matchingAiKeywords(item, keywords) })), [snapshot, keywords]);
  const followed = headlines.filter(({ matches }) => matches.length > 0);
  const preview = followed.slice(0, 3);
  return <>
    <div className="ai-focus-preview">
      <div className="ai-focus-heading"><strong>我的关注 <span>{followed.length}</span></strong><small>过去 24 小时</small></div>
      {preview.length ? <ul className="ai-focus-list">{preview.map(({ item, matches }) => <li key={item.id}>
        <button className="ai-focus-headline" disabled={!item.aihotUrl && !item.originalUrl} onClick={() => void actions.onOpenExternal(item.aihotUrl || item.originalUrl)} title={item.title}><strong>{item.title}</strong></button>
        <div className="ai-focus-meta"><span title={matches.join(" / ")}>★ {matches.join(" / ")}</span><time dateTime={item.publishedAt}>{formatPublished(item.publishedAt)}</time></div>
      </li>)}</ul> : <p className="ai-focus-empty">{!headlines.length ? busy ? "正在获取 AI 动态…" : error || "暂时没有可显示的 AI 动态。" : keywords.length ? "暂无关注词命中的消息，可查看全部动态。" : "设置关注词后，在这里速览你关心的消息。"}</p>}
      {followed.length > preview.length && <Button variant="ghost" size="small" onClick={() => setFilter("followed")}>还有 {followed.length - preview.length} 条关注，点击查看 →</Button>}
    </div>
    <nav className="ai-news-entries" aria-label="AI 资讯阅读">
      <Button variant="secondary" size="small" onClick={() => setFilter("all")}>查看全部动态 · {headlines.length} →</Button>
      {snapshot?.daily && <Button variant="ghost" size="small" onClick={() => void actions.onOpenExternal(snapshot.daily!.url || snapshot.attribution.url)}>AI 日报 · {shortDate(snapshot.daily.date)} ↗</Button>}
    </nav>
    {filter && <AiNewsDialog headlines={headlines} initialFilter={filter} keywords={keywords} busy={busy} error={error} onRefresh={onRefresh} onClose={() => setFilter(null)} sourceStatus={sourceStatus} {...actions} />}
  </>;
}

function AiNewsDialog({ headlines, initialFilter, keywords, busy, error, onRefresh, onClose, sourceStatus, ...actions }: NewsActions & {
  headlines: Headline[];
  initialFilter: NewsFilter;
  keywords: string[];
  busy: boolean;
  error: string;
  onRefresh: () => void;
  onClose: () => void;
  sourceStatus: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [filter, setFilter] = useState(initialFilter);
  const followed = headlines.filter(({ matches }) => matches.length > 0);
  const visible = filter === "followed" ? followed : headlines;
  useEffect(() => {
    const previousFocus = document.activeElement;
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  return createPortal(<dialog ref={dialog} className="ai-news-dialog" aria-labelledby="ai-news-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <header><div><span>过去 24 小时 · 关注优先</span><h2 id="ai-news-title">AI 动态</h2></div><nav><Button variant="ghost" size="small" disabled={busy} onClick={onRefresh}>{busy ? "更新中…" : "刷新"}</Button><Button variant="secondary" size="small" iconOnly autoFocus onClick={onClose} aria-label="关闭 AI 动态">×</Button></nav></header>
    <nav className="ai-news-filters" aria-label="筛选 AI 动态"><Button variant={filter === "all" ? "primary" : "ghost"} size="small" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>全部 {headlines.length}</Button><Button variant={filter === "followed" ? "primary" : "ghost"} size="small" aria-pressed={filter === "followed"} onClick={() => setFilter("followed")}>我的关注 {followed.length}</Button></nav>
    <div className="ai-news-scroll" key={filter}>
      {visible.length ? <ol className="ai-news-list">{visible.map(({ item, matches }, index) => <li key={item.id} className={matches.length ? "followed" : ""}>
        <span className="ai-news-index">{index + 1}</span><div className="ai-news-content">
          <button className="ai-focus-headline" disabled={!item.aihotUrl && !item.originalUrl} onClick={() => void actions.onOpenExternal(item.aihotUrl || item.originalUrl)}><strong>{item.title}</strong></button>
          <div className="ai-news-meta"><span>{item.sourceName || "AIHOT"}</span><time dateTime={item.publishedAt}>{formatPublished(item.publishedAt)}</time>{matches.length > 0 && <mark>★ {matches.join(" / ")}</mark>}</div>
          {(item.summary || item.reason) && <details className="ai-news-summary"><summary>查看摘要</summary><p>{item.summary || item.reason}</p></details>}
          <nav className="ai-news-item-actions"><Button variant="ghost" size="small" disabled={!item.originalUrl} onClick={() => void actions.onOpenExternal(item.originalUrl)}>原文 ↗</Button><Button variant="secondary" size="small" disabled={actions.savedIds.has(item.id)} onClick={() => void actions.onSave(item)}>{actions.savedIds.has(item.id) ? "已收藏" : "收藏"}</Button></nav>
        </div>
      </li>)}</ol> : <p className="ai-news-empty">{filter === "followed" ? keywords.length ? "暂无关注词命中的消息。" : "尚未设置关注词，可以先查看全部动态。" : busy ? "正在获取 AI 动态…" : error || "暂时没有可显示的 AI 动态。"}</p>}
    </div>
    {sourceStatus}
  </dialog>, document.body);
}

function formatPublished(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function shortDate(value: string) {
  return `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}`;
}
