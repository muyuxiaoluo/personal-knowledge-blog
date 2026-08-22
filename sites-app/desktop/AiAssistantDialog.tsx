import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isAiResponseSettled, isMoreCompleteAiAnswer, shouldConfirmAiConversationDeletion } from "../app/ai-response-settling";
import type { AiConversation, AiMessage, DeepSeekSnapshot } from "../app/ai-types";
import type { SqliteAiRepository } from "../app/data/sqlite-ai-repository";
import { BrandLogo } from "./BrandLogo";
import { desktopApi } from "./integrationApi";

type PendingAnswer = {
  conversationId: string;
  baseline: string;
  lastText: string;
  lastTextChangedAt: number;
  startedAt: number;
  hasGenerated: boolean;
  observedGenerating: boolean;
  saving: boolean;
};

const preparingSnapshot: DeepSeekSnapshot = {
  status: "preparing",
  ready: false,
  generating: false,
  text: "",
  conversationRef: "",
  error: "",
  adapterVersion: 2,
};

export function AiAssistantDialog({ open, repository, onClose }: {
  open: boolean;
  repository: SqliteAiRepository;
  onClose: () => void;
}) {
  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [snapshot, setSnapshot] = useState<DeepSeekSnapshot>(preparingSnapshot);
  const [draftAnswer, setDraftAnswer] = useState("");
  const [prompt, setPrompt] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AiConversation | null>(null);
  const pending = useRef<PendingAnswer | null>(null);
  const selectedIdRef = useRef("");

  const refreshConversations = useCallback(async (preferredId?: string) => {
    const next = await repository.listConversations();
    setConversations(next);
    const target = preferredId || selectedIdRef.current || next[0]?.id || "";
    selectedIdRef.current = target;
    setSelectedId(target);
    setMessages(target ? await repository.listMessages(target) : []);
    return next.find((item) => item.id === target) ?? null;
  }, [repository]);

  const syncLatestOfficialAnswer = useCallback(async (conversationId: string, expectedRef: string) => {
    if (!isTauri()) return;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const next = await desktopApi.deepseek.status();
      setSnapshot(next);
      if (sameConversationRef(next.conversationRef, expectedRef) && next.ready && !next.generating && next.text) {
        const localMessages = await repository.listMessages(conversationId);
        const latestAssistant = [...localMessages].reverse().find((message) => message.role === "assistant");
        if (latestAssistant && isMoreCompleteAiAnswer(latestAssistant.content, next.text)) {
          await repository.updateMessageContent(latestAssistant.id, next.text);
          if (selectedIdRef.current === conversationId) setMessages(await repository.listMessages(conversationId));
        }
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
  }, [repository]);

  const createConversation = useCallback(async (controlWebsite = true) => {
    setBusy(true);
    setNotice("");
    try {
      if (controlWebsite && isTauri()) await desktopApi.deepseek.newConversation();
      const created = await repository.createConversation();
      selectedIdRef.current = created.id;
      setSelectedId(created.id);
      setMessages([]);
      setDraftAnswer("");
      await refreshConversations(created.id);
    } catch (error) {
      setNotice(describeError(error));
    } finally {
      setBusy(false);
    }
  }, [refreshConversations, repository]);

  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void (async () => {
      await repository.cleanupExpired();
      let current = await refreshConversations();
      if (!current) {
        const created = await repository.createConversation();
        current = created;
        await refreshConversations(created.id);
      }
      if (disposed || !isTauri()) return;
      setSnapshot(await desktopApi.deepseek.prepare());
      if (current.remoteRef) {
        try {
          await desktopApi.deepseek.restore(current.remoteRef);
          await repository.updateRemoteState(current.id, current.remoteRef, "restored");
          await syncLatestOfficialAnswer(current.id, current.remoteRef).catch(() => undefined);
          await refreshConversations(current.id);
        } catch {
          await repository.updateRemoteState(current.id, current.remoteRef, "unavailable");
          await refreshConversations(current.id);
          setNotice("官网原会话暂时无法恢复，本地记录仍然完整；可以新建官网会话继续。");
        }
      }
    })().catch((error) => !disposed && setNotice(describeError(error)));
    return () => { disposed = true; void desktopApi.deepseek.release(); };
  }, [open, refreshConversations, repository, syncLatestOfficialAnswer]);

  useEffect(() => {
    if (!open || !isTauri()) return;
    let disposed = false;
    const poll = async () => {
      try {
        const next = await desktopApi.deepseek.status();
        if (disposed) return;
        setSnapshot(next);
        const active = pending.current;
        if (!active) return;
        if (next.generating) {
          active.hasGenerated = true;
          active.observedGenerating = true;
        }
        if (next.text && next.text !== active.lastText) {
          active.lastText = next.text;
          active.lastTextChangedAt = Date.now();
          if (next.text !== active.baseline) active.hasGenerated = true;
        }
        if (next.text && next.text !== active.baseline) setDraftAnswer(next.text);
        const changed = Boolean(next.text && next.text !== active.baseline);
        const stableFor = Date.now() - active.lastTextChangedAt;
        const settled = isAiResponseSettled({
          generating: next.generating,
          changed,
          hasGenerated: active.hasGenerated,
          observedGenerating: active.observedGenerating,
          stableForMs: stableFor,
        });
        if (settled && !active.saving) {
          active.saving = true;
          const saved = await repository.addMessage(active.conversationId, "assistant", next.text);
          if (disposed) return;
          if (active.conversationId === selectedIdRef.current) setMessages((value) => [...value, saved]);
          if (next.conversationRef) await repository.updateRemoteState(active.conversationId, next.conversationRef, "restored");
          pending.current = null;
          setDraftAnswer("");
          await refreshConversations(active.conversationId);
        } else if (!next.generating && !changed && Date.now() - active.startedAt > 30_000) {
          pending.current = null;
          setNotice(next.error || "没有读取到新的回答。可以打开官网检查页面状态后重试。");
        }
      } catch (error) {
        if (!disposed) setNotice(describeError(error));
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [open, refreshConversations, repository]);

  async function selectConversation(conversation: AiConversation) {
    if (pending.current) return;
    selectedIdRef.current = conversation.id;
    setSelectedId(conversation.id);
    setMessages(await repository.listMessages(conversation.id));
    setDraftAnswer("");
    setNotice("");
    if (!conversation.remoteRef || !isTauri()) return;
    try {
      await desktopApi.deepseek.restore(conversation.remoteRef);
      await repository.updateRemoteState(conversation.id, conversation.remoteRef, "restored");
      await syncLatestOfficialAnswer(conversation.id, conversation.remoteRef).catch(() => undefined);
    } catch {
      await repository.updateRemoteState(conversation.id, conversation.remoteRef, "unavailable");
      setNotice("未能恢复官网原会话；本地内容仍可查看，可以新建会话继续。");
    }
    await refreshConversations(conversation.id);
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const body = prompt.trim();
    if (!body || pending.current || !selectedId) return;
    if (!snapshot.ready) {
      setNotice(snapshot.status === "login_required" ? "请先完成 DeepSeek 官网登录。" : "DeepSeek 页面还没有准备好。");
      return;
    }
    setNotice("");
    const userMessage = await repository.addMessage(selectedId, "user", body);
    setMessages((value) => [...value, userMessage]);
    setPrompt("");
    pending.current = {
      conversationId: selectedId,
      baseline: snapshot.text,
      lastText: snapshot.text,
      lastTextChangedAt: Date.now(),
      startedAt: Date.now(),
      hasGenerated: false,
      observedGenerating: false,
      saving: false,
    };
    try {
      setSnapshot(await desktopApi.deepseek.send(body));
      await refreshConversations(selectedId);
    } catch (error) {
      pending.current = null;
      setNotice(describeError(error));
    }
  }

  async function stop() {
    try { setSnapshot(await desktopApi.deepseek.stop()); }
    catch (error) { setNotice(describeError(error)); }
  }

  async function togglePinned(conversation: AiConversation) {
    await repository.setPinned(conversation.id, !conversation.pinned);
    await refreshConversations(conversation.id);
  }

  async function requestRemoveConversation(conversation: AiConversation) {
    try {
      const conversationMessages = await repository.listMessages(conversation.id);
      if (shouldConfirmAiConversationDeletion(conversationMessages.length)) {
        setDeleteTarget(conversation);
        return;
      }
      await removeConversation(conversation, true);
    } catch (error) {
      setNotice(`无法检查这条会话：${describeError(error)}`);
    }
  }

  async function removeConversation(conversation: AiConversation, skipOfficial = false) {
    const hasOfficialConversation = (() => {
      try { return Boolean(conversation.remoteRef && new URL(conversation.remoteRef).pathname !== "/"); }
      catch { return false; }
    })();
    setBusy(true);
    setNotice("");
    let officialDeleted = false;
    try {
      if (!skipOfficial && hasOfficialConversation && conversation.remoteRef) {
        await desktopApi.deepseek.deleteConversation(conversation.remoteRef);
        officialDeleted = true;
      }
    } catch (error) {
      setNotice(`官网会话没有删除，本地记录已保留。${describeError(error)}`);
      setBusy(false);
      setDeleteTarget(null);
      return;
    }
    try {
      await repository.deleteConversation(conversation.id);
    } catch (error) {
      setNotice(officialDeleted ? `官网会话已删除，但清理本地记录失败：${describeError(error)}` : `删除本地记录失败：${describeError(error)}`);
      setBusy(false);
      setDeleteTarget(null);
      return;
    }
    const remaining = await repository.listConversations();
    selectedIdRef.current = remaining[0]?.id || "";
    if (!remaining.length) await createConversation(false);
    else await refreshConversations(remaining[0].id);
    setBusy(false);
    setDeleteTarget(null);
  }

  if (!open) return null;
  const selected = conversations.find((item) => item.id === selectedId) ?? null;
  const status = statusLabel(snapshot);

  return (
    <div className="ai-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending.current) onClose();
    }}>
      <section className="ai-assistant-dialog" role="dialog" aria-modal="true" aria-label="DeepSeek AI 助手">
        <aside className="ai-history-panel">
          <header><div><span>AI 助手</span><strong>DeepSeek</strong></div><button onClick={() => void createConversation()} disabled={busy || Boolean(pending.current)}>＋</button></header>
          <div className="ai-history-list">
            {conversations.map((conversation) => <article className={selectedId === conversation.id ? "active" : ""} key={conversation.id}>
              <button className="ai-history-open" onClick={() => void selectConversation(conversation)} disabled={Boolean(pending.current)}><strong>{conversation.title}</strong><small>{formatConversationDate(conversation.updatedAt)}{conversation.restoreState === "unavailable" ? " · 仅本地" : ""}</small></button>
              <div><button onClick={() => void togglePinned(conversation)} title={conversation.pinned ? "取消收藏" : "收藏"}>{conversation.pinned ? "★" : "☆"}</button><button onClick={() => void requestRemoveConversation(conversation)} title="删除会话">×</button></div>
            </article>)}
          </div>
          <footer><span>普通记录保存 30 天</span><small>收藏后长期保留</small></footer>
        </aside>

        <div className="ai-chat-panel">
          <header className="ai-chat-header">
            <div><strong>{selected?.title || "新对话"}</strong><span className={`ai-status ${snapshot.status}`}>{status}</span></div>
            <nav><button onClick={() => void desktopApi.deepseek.prepare().then(setSnapshot).catch((error) => setNotice(describeError(error)))}>重新连接</button><button onClick={() => void desktopApi.deepseek.showOfficial().catch((error) => setNotice(describeError(error)))}>{snapshot.status === "login_required" ? "前往登录" : "打开官网"}</button><button className="close" onClick={onClose} disabled={Boolean(pending.current)}>×</button></nav>
          </header>

          <div className="ai-message-scroll">
            {!messages.length && !draftAnswer && <div className="ai-empty-state"><i><BrandLogo brand="deepseek" /></i><h2>直接写下你的问题</h2><p>这里使用你自己的 DeepSeek 网页会话，不会调用付费模型 API。</p></div>}
            {messages.map((message) => <article className={`ai-message ${message.role}`} key={message.id}>
              <span className="ai-message-avatar" aria-label={message.role === "user" ? "你" : "DeepSeek"}>{message.role === "user" ? "你" : <BrandLogo brand="deepseek" />}</span>
              <div><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>
            </article>)}
            {draftAnswer && <article className="ai-message assistant streaming"><span className="ai-message-avatar" aria-label="DeepSeek"><BrandLogo brand="deepseek" /></span><div><ReactMarkdown remarkPlugins={[remarkGfm]}>{draftAnswer}</ReactMarkdown><i /></div></article>}
          </div>

          {notice && <div className="ai-notice" role="alert"><span>{notice}</span><button onClick={() => setNotice("")}>×</button></div>}
          <form className="ai-composer" onSubmit={send}>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
            }} placeholder={snapshot.status === "login_required" ? "请先在官网窗口完成登录…" : "问一个简单的问题，Enter 发送，Shift + Enter 换行"} disabled={!snapshot.ready || Boolean(pending.current)} />
            <footer><span>网页 DOM 适配 · 仅个人低频使用</span>{pending.current ? <button type="button" className="stop" onClick={() => void stop()}>■ 停止</button> : <button disabled={!prompt.trim() || !snapshot.ready}>发送 ↑</button>}</footer>
          </form>
        </div>
      </section>
      {deleteTarget && <div className="ai-delete-confirm-backdrop" role="presentation">
        <section className="ai-delete-confirm" role="alertdialog" aria-modal="true" aria-labelledby="ai-delete-title">
          <span>删除会话</span>
          <h2 id="ai-delete-title">确定删除“{deleteTarget.title}”吗？</h2>
          {deleteTarget.remoteRef && (() => { try { return new URL(deleteTarget.remoteRef).pathname !== "/"; } catch { return false; } })()
            ? <p>将先删除 DeepSeek 官网中的对应会话，确认成功后再删除本地记录。这个操作无法恢复。</p>
            : <p>这个记录尚未关联到官网会话，只会删除本地内容。这个操作无法恢复。</p>}
          <div><button onClick={() => setDeleteTarget(null)} disabled={busy}>取消</button><button className="danger" onClick={() => void removeConversation(deleteTarget)} disabled={busy}>{busy ? "正在同步删除…" : "确认删除"}</button></div>
        </section>
      </div>}
    </div>
  );
}

function statusLabel(snapshot: DeepSeekSnapshot) {
  if (!isTauri()) return "需要桌面端";
  if (snapshot.status === "login_required") return "需要登录";
  if (snapshot.status === "generating") return "正在回答";
  if (snapshot.status === "adapter_error") return "适配器异常";
  if (snapshot.status === "ready") return "已连接";
  return "正在准备";
}

function formatConversationDate(value: string) {
  const date = new Date(value);
  if (Date.now() - date.getTime() < 24 * 60 * 60 * 1000) return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function sameConversationRef(left: string, right: string) {
  try { return new URL(left).pathname.replace(/\/$/, "") === new URL(right).pathname.replace(/\/$/, ""); }
  catch { return false; }
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error || "操作没有完成");
}
