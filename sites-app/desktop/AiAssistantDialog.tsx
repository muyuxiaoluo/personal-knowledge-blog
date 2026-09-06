import "./styles/ai-tools.css";
import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isAiResponseSettled, isMoreCompleteAiAnswer, shouldConfirmAiConversationDeletion } from "../app/ai-response-settling";
import type { AiConversation, AiMessage, DeepSeekModeOptions, DeepSeekPrimaryMode, DeepSeekSnapshot } from "../app/ai-types";
import type { SqliteAiRepository } from "../app/data/sqlite-ai-repository";
import { BrandLogo } from "./BrandLogo";
import { desktopApi } from "./integrationApi";
import { Button } from "./DesktopControls";

type PendingAnswer = {
  conversationId: string;
  baseline: string;
  baselineReasoning: string;
  lastText: string;
  lastReasoning: string;
  capturedReasoning: string;
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
  reasoningText: "",
  conversationRef: "",
  error: "",
  deepThinkingAvailable: false,
  deepThinkingEnabled: false,
  expertModeAvailable: false,
  expertModeEnabled: false,
  smartSearchAvailable: false,
  smartSearchEnabled: false,
  visionAvailable: false,
  attachmentName: "",
  adapterVersion: 5,
};

const defaultModeOptions: DeepSeekModeOptions = {
  deepThinking: true,
  expertMode: false,
  smartSearch: false,
};

const modeOperationTimeoutMs = 12_000;

export function AiAssistantDialog({ open, repository, onClose, embedded = false, onPendingChange }: {
  open: boolean;
  repository: SqliteAiRepository;
  onClose?: () => void;
  embedded?: boolean;
  onPendingChange?: (pending: boolean) => void;
}) {
  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [snapshot, setSnapshot] = useState<DeepSeekSnapshot>(preparingSnapshot);
  const [draftAnswer, setDraftAnswer] = useState("");
  const [draftReasoning, setDraftReasoning] = useState("");
  const [prompt, setPrompt] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);
  const [modeOptions, setModeOptions] = useState<DeepSeekModeOptions>(defaultModeOptions);
  const [deleteTarget, setDeleteTarget] = useState<AiConversation | null>(null);
  const pending = useRef<PendingAnswer | null>(null);
  const selectedIdRef = useRef("");
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  const setPendingAnswer = useCallback((value: PendingAnswer | null) => {
    pending.current = value;
    onPendingChange?.(Boolean(value));
  }, [onPendingChange]);

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
        const richerAnswer = latestAssistant && isMoreCompleteAiAnswer(latestAssistant.content, next.text);
        const richerReasoning = latestAssistant && Boolean(next.reasoningText && next.reasoningText !== latestAssistant.reasoning);
        if (latestAssistant && (richerAnswer || richerReasoning)) {
          await repository.updateMessageContent(latestAssistant.id, richerAnswer ? next.text : latestAssistant.content, next.reasoningText || latestAssistant.reasoning);
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
      if (controlWebsite && isTauri()) {
        const next = await desktopApi.deepseek.newConversation();
        setSnapshot(next);
        setModeOptions(modesFromSnapshot(next, defaultModeOptions));
      }
      const created = await repository.createConversation();
      selectedIdRef.current = created.id;
      setSelectedId(created.id);
      setMessages([]);
      setDraftAnswer("");
      setDraftReasoning("");
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
    setModeOptions(defaultModeOptions);
    void (async () => {
      await repository.cleanupExpired();
      let current = await refreshConversations();
      if (!current) {
        const created = await repository.createConversation();
        current = created;
        await refreshConversations(created.id);
      }
      if (disposed || !isTauri()) return;
      const prepared = await desktopApi.deepseek.prepare();
      setSnapshot(prepared);
      setModeOptions(modesFromSnapshot(prepared, defaultModeOptions));
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
    return () => {
      disposed = true;
      onPendingChange?.(false);
      void desktopApi.deepseek.release();
    };
  }, [onPendingChange, open, refreshConversations, repository, syncLatestOfficialAnswer]);

  useEffect(() => {
    if (!open || !isTauri()) return;
    let disposed = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const next = await desktopApi.deepseek.status();
        if (disposed) return;
        setSnapshot(next);
        setModeOptions((value) => modesFromSnapshot(next, value));
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
        if (next.reasoningText && next.reasoningText !== active.lastReasoning) {
          active.lastReasoning = next.reasoningText;
          active.lastTextChangedAt = Date.now();
          if (next.reasoningText !== active.baselineReasoning) {
            active.capturedReasoning = next.reasoningText;
            active.hasGenerated = true;
          }
        }
        if (next.text && next.text !== active.baseline) setDraftAnswer(next.text);
        if (next.reasoningText && next.reasoningText !== active.baselineReasoning) setDraftReasoning(next.reasoningText);
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
          const saved = await repository.addMessage(active.conversationId, "assistant", next.text, active.capturedReasoning);
          if (disposed) return;
          if (active.conversationId === selectedIdRef.current) setMessages((value) => [...value, saved]);
          if (next.conversationRef) await repository.updateRemoteState(active.conversationId, next.conversationRef, "restored");
          setPendingAnswer(null);
          setDraftAnswer("");
          setDraftReasoning("");
          await refreshConversations(active.conversationId);
        } else if (!next.generating && !changed && Date.now() - active.startedAt > 30_000) {
          setPendingAnswer(null);
          setNotice(next.error || "没有读取到新的回答。可以打开官网检查页面状态后重试。");
        }
      } catch (error) {
        if (!disposed) setNotice(describeError(error));
      } finally {
        if (!disposed) timer = window.setTimeout(() => void poll(), 500);
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [open, refreshConversations, repository, setPendingAnswer]);

  async function selectConversation(conversation: AiConversation) {
    if (pending.current) return;
    selectedIdRef.current = conversation.id;
    setSelectedId(conversation.id);
    setMessages(await repository.listMessages(conversation.id));
    setDraftAnswer("");
    setDraftReasoning("");
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

  async function updateModes(patch: Partial<DeepSeekModeOptions>) {
    if (!snapshot.ready || pending.current || modeBusy) return false;
    const nextOptions = { ...modeOptions, ...patch };
    setModeBusy(true);
    setNotice("");
    try {
      const next = await withTimeout(
        desktopApi.deepseek.configureModes(nextOptions),
        modeOperationTimeoutMs,
        "官网模式切换超时，请重新连接后再试。",
      );
      if (next.status === "adapter_error" && next.error) throw new Error(next.error);
      if (next.expertModeAvailable && next.expertModeEnabled !== nextOptions.expertMode) {
        throw new Error(`官网仍处于${next.expertModeEnabled ? "专家模式" : "快速模式"}。`);
      }
      setSnapshot(next);
      setModeOptions(modesFromSnapshot(next, nextOptions));
      return true;
    } catch (error) {
      setNotice(`官网模式没有切换成功：${describeError(error)}`);
      return false;
    } finally {
      setModeBusy(false);
    }
  }

  async function selectPrimaryMode(mode: DeepSeekPrimaryMode) {
    if (!snapshot.ready || pending.current || modeBusy) return;
    if (mode === "vision") {
      imageInputRef.current?.click();
      return;
    }
    const currentMode: DeepSeekPrimaryMode = snapshot.attachmentName ? "vision" : modeOptions.expertMode ? "expert" : "quick";
    if (mode === currentMode) return;
    const shouldStartFresh = messages.length > 0 || Boolean(draftAnswer);
    if (shouldStartFresh) {
      await createConversation();
    } else {
      const freshSnapshot = await desktopApi.deepseek.newConversation();
      setSnapshot(freshSnapshot);
      setModeOptions(modesFromSnapshot(freshSnapshot, defaultModeOptions));
    }
    const changed = await updateModes({ expertMode: mode === "expert" });
    if (changed && shouldStartFresh) setNotice(`已保留原对话，并为${mode === "expert" ? "专家模式" : "快速模式"}开启新对话。`);
  }

  async function attachImage(file: File | undefined) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setNotice("图片过大，请选择 10 MB 以内的图片。");
      return;
    }
    const mime = inferImageMime(file);
    if (!mime) {
      setNotice("请选择 PNG、JPEG、WebP 或 GIF 图片。");
      return;
    }
    setModeBusy(true);
    setNotice("");
    try {
      const nextConversation = await desktopApi.deepseek.newConversation();
      setSnapshot(nextConversation);
      if (messages.length > 0 || draftAnswer || modeOptions.expertMode) {
        const created = await repository.createConversation();
        selectedIdRef.current = created.id;
        setSelectedId(created.id);
        setMessages([]);
        setDraftAnswer("");
        setDraftReasoning("");
        await refreshConversations(created.id);
      }
      const quickOptions = { ...modeOptions, expertMode: false };
      const quickSnapshot = await withTimeout(
        desktopApi.deepseek.configureModes(quickOptions),
        modeOperationTimeoutMs,
        "切换到识图所需模式超时，请重新连接后再试。",
      );
      if (quickSnapshot.status === "adapter_error" && quickSnapshot.error) throw new Error(quickSnapshot.error);
      setModeOptions(modesFromSnapshot(quickSnapshot, quickOptions));
      const next = await desktopApi.deepseek.attachImage(file.name, mime, await readFileAsDataUrl(file));
      if (next.status === "adapter_error" && next.error) throw new Error(next.error);
      setSnapshot(next);
    } catch (error) {
      setNotice(`图片没有添加到官网会话：${describeError(error)}`);
    } finally {
      if (imageInputRef.current) imageInputRef.current.value = "";
      setModeBusy(false);
    }
  }

  async function removeAttachment() {
    setModeBusy(true);
    setNotice("");
    try {
      const next = await desktopApi.deepseek.removeAttachment();
      if (next.status === "adapter_error" && next.error) throw new Error(next.error);
      setSnapshot(next);
    } catch (error) {
      setNotice(describeError(error));
    } finally {
      setModeBusy(false);
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const body = prompt.trim();
    if (!body || pending.current || !selectedId || modeBusy) return;
    if (!snapshot.ready) {
      setNotice(snapshot.status === "login_required" ? "请先完成 DeepSeek 官网登录。" : "DeepSeek 页面还没有准备好。");
      return;
    }
    setNotice("");
    const activeSnapshot = snapshot;
    const userMessage = await repository.addMessage(selectedId, "user", body);
    setMessages((value) => [...value, userMessage]);
    setPrompt("");
    setPendingAnswer({
      conversationId: selectedId,
      baseline: activeSnapshot.text,
      baselineReasoning: activeSnapshot.reasoningText,
      lastText: activeSnapshot.text,
      lastReasoning: activeSnapshot.reasoningText,
      capturedReasoning: "",
      lastTextChangedAt: Date.now(),
      startedAt: Date.now(),
      hasGenerated: false,
      observedGenerating: false,
      saving: false,
    });
    try {
      setSnapshot(await desktopApi.deepseek.send(body));
      await refreshConversations(selectedId);
    } catch (error) {
      setPendingAnswer(null);
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
    let officialDeleteError = "";
    try {
      if (!skipOfficial && hasOfficialConversation && conversation.remoteRef) {
        await desktopApi.deepseek.deleteConversation(conversation.remoteRef);
        officialDeleted = true;
      }
    } catch (error) {
      officialDeleteError = describeError(error);
    }
    try {
      await repository.deleteConversation(conversation.id);
    } catch (error) {
      setNotice(officialDeleted
        ? `官网会话已删除，但清理本地记录失败：${describeError(error)}`
        : `删除本地记录失败：${describeError(error)}${officialDeleteError ? `；此前官网同步删除也失败：${officialDeleteError}` : ""}`);
      setBusy(false);
      setDeleteTarget(null);
      return;
    }
    const remaining = await repository.listConversations();
    selectedIdRef.current = remaining[0]?.id || "";
    if (!remaining.length) await createConversation(false);
    else await refreshConversations(remaining[0].id);
    if (officialDeleteError) setNotice(`本地记录已删除；官网会话未同步删除。${officialDeleteError}`);
    setBusy(false);
    setDeleteTarget(null);
  }

  if (!open) return null;
  const selected = conversations.find((item) => item.id === selectedId) ?? null;
  const status = statusLabel(snapshot, Boolean(draftReasoning && !draftAnswer));
  const primaryMode: DeepSeekPrimaryMode = snapshot.attachmentName ? "vision" : modeOptions.expertMode ? "expert" : "quick";
  const primaryModeSelector = <PrimaryModeSelector
    mode={primaryMode}
    ready={snapshot.ready}
    expertAvailable={snapshot.expertModeAvailable}
    visionAvailable={snapshot.visionAvailable}
    busy={modeBusy || Boolean(pending.current)}
    compact={messages.length > 0 || Boolean(draftAnswer) || Boolean(draftReasoning)}
    onSelect={(mode) => void selectPrimaryMode(mode)}
  />;

  const assistant = (
      <section className={`ai-assistant-dialog${embedded ? " embedded" : ""}`} role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-label="DeepSeek AI 助手">
        <aside className="ai-history-panel">
          <header><div><span>AI 助手</span><strong>DeepSeek</strong></div><Button variant="secondary" size="small" iconOnly aria-label="添加" type="button" onClick={() => void createConversation()} disabled={busy || Boolean(pending.current)}>＋</Button></header>
          <div className="ai-history-list">
            {conversations.map((conversation) => <article className={selectedId === conversation.id ? "active" : ""} key={conversation.id}>
              <button className="ai-history-open" onClick={() => void selectConversation(conversation)} disabled={Boolean(pending.current)}><strong>{conversation.title}</strong><small>{formatConversationDate(conversation.updatedAt)}{conversation.restoreState === "unavailable" ? " · 仅本地" : ""}</small></button>
              <div><Button variant="secondary" type="button" onClick={() => void togglePinned(conversation)} title={conversation.pinned ? "取消收藏" : "收藏"}>{conversation.pinned ? "★" : "☆"}</Button><Button variant="secondary" size="small" iconOnly aria-label="关闭" type="button" onClick={() => void requestRemoveConversation(conversation)} title="删除会话">×</Button></div>
            </article>)}
          </div>
          <footer><span>普通记录保存 30 天</span><small>收藏后长期保留</small></footer>
        </aside>

        <div className="ai-chat-panel">
          <header className="ai-chat-header">
            <div><strong>{selected?.title || "新对话"}</strong><span className={`ai-status ${snapshot.status}`}>{status}</span></div>
            <nav><Button variant="secondary" type="button" onClick={() => void desktopApi.deepseek.prepare().then(setSnapshot).catch((error) => setNotice(describeError(error)))}>重新连接</Button><Button variant="secondary" type="button" onClick={() => void desktopApi.deepseek.showOfficial().catch((error) => setNotice(describeError(error)))}>{snapshot.status === "login_required" ? "前往登录" : "打开官网"}</Button>{!embedded && <Button variant="secondary" size="small" iconOnly type="button" className="close" onClick={onClose} disabled={Boolean(pending.current)}>×</Button>}</nav>
          </header>

          <div className="ai-message-scroll">
            {!messages.length && !draftAnswer && !draftReasoning && <div className="ai-empty-state">{primaryModeSelector}<p>这里使用你自己的 DeepSeek 网页会话，不会调用付费模型 API。</p></div>}
            {messages.map((message) => <article className={`ai-message ${message.role}`} key={message.id}>
              <span className="ai-message-avatar" aria-label={message.role === "user" ? "你" : "DeepSeek"}>{message.role === "user" ? "你" : <BrandLogo brand="deepseek" />}</span>
              <div>{message.role === "assistant" ? <AssistantMessageContent content={message.content} reasoning={message.reasoning} /> : <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>}</div>
            </article>)}
            {(draftAnswer || draftReasoning) && <article className="ai-message assistant streaming"><span className="ai-message-avatar" aria-label="DeepSeek"><BrandLogo brand="deepseek" /></span><div><AssistantMessageContent content={draftAnswer} reasoning={draftReasoning} streaming /></div></article>}
          </div>

          {(messages.length > 0 || draftAnswer || draftReasoning) && primaryModeSelector}
          {notice && <div className="ai-notice" role="alert"><span>{notice}</span><Button variant="secondary" size="small" iconOnly aria-label="关闭" type="button" onClick={() => setNotice("")}>×</Button></div>}
          <form className="ai-composer" onSubmit={send}>
            <input ref={imageInputRef} className="ai-image-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => void attachImage(event.target.files?.[0])} />
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
            }} placeholder={snapshot.status === "login_required" ? "请先在官网窗口完成登录…" : "问一个简单的问题，Enter 发送，Shift + Enter 换行"} disabled={!snapshot.ready || Boolean(pending.current)} />
            <footer>
              <div className="ai-capability-tools" aria-label="回答能力">
                <button type="button" className={snapshot.deepThinkingAvailable && modeOptions.deepThinking ? "active" : ""} disabled={!snapshot.ready || !snapshot.deepThinkingAvailable || modeBusy || Boolean(pending.current)} title={snapshot.deepThinkingAvailable ? "使用 DeepSeek 官网的深度思考" : "官网当前未提供或适配器尚未识别"} onClick={() => void updateModes({ deepThinking: !modeOptions.deepThinking })}>◉ 深度思考</button>
                <button type="button" className={snapshot.smartSearchAvailable && modeOptions.smartSearch ? "active" : ""} disabled={!snapshot.ready || !snapshot.smartSearchAvailable || modeBusy || Boolean(pending.current)} title={snapshot.smartSearchAvailable ? "使用 DeepSeek 官网的智能搜索" : "官网当前未提供或适配器尚未识别"} onClick={() => void updateModes({ smartSearch: !modeOptions.smartSearch })}>◎ 智能搜索</button>
                {snapshot.attachmentName && <span className="ai-attachment-chip"><span>{snapshot.attachmentName}</span><Button variant="secondary" size="small" iconOnly type="button" aria-label="移除图片" title="移除图片" onClick={() => void removeAttachment()} disabled={modeBusy || Boolean(pending.current)}>×</Button></span>}
              </div>
              <div className="ai-composer-actions">
                <Button variant="secondary" size="small" iconOnly type="button" className="ai-attach-button" aria-label="添加图片" title="添加图片" disabled={!snapshot.ready || !snapshot.visionAvailable || modeBusy || Boolean(pending.current)} onClick={() => imageInputRef.current?.click()}>📎</Button>
                {pending.current ? <Button variant="secondary" type="button" className="stop" onClick={() => void stop()}>■ 停止</Button> : <Button variant="primary" type="submit" className="send" disabled={!prompt.trim() || !snapshot.ready || modeBusy}>发送 ↑</Button>}
              </div>
            </footer>
          </form>
        </div>
      </section>
  );

  const confirmation = deleteTarget && <div className="ai-delete-confirm-backdrop" role="presentation">
    <section className="ai-delete-confirm" role="alertdialog" aria-modal="true" aria-labelledby="ai-delete-title">
      <span>删除会话</span>
      <h2 id="ai-delete-title">确定删除“{deleteTarget.title}”吗？</h2>
      {deleteTarget.remoteRef && (() => { try { return new URL(deleteTarget.remoteRef).pathname !== "/"; } catch { return false; } })()
        ? <p>将先尝试删除 DeepSeek 官网中的对应会话；即使官网同步失败，也会删除本地记录。这个操作无法恢复。</p>
        : <p>这个记录尚未关联到官网会话，只会删除本地内容。这个操作无法恢复。</p>}
      <div><Button variant="secondary" type="button" onClick={() => setDeleteTarget(null)} disabled={busy}>取消</Button><Button variant="danger" onClick={() => void removeConversation(deleteTarget)} disabled={busy}>{busy ? "正在同步删除…" : "确认删除"}</Button></div>
    </section>
  </div>;

  if (embedded) return <div className="ai-assistant-page">{assistant}{confirmation}</div>;

  return (
    <div className="ai-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !pending.current) onClose?.();
    }}>
      {assistant}
      {confirmation}
    </div>
  );
}

function PrimaryModeSelector({ mode, ready, expertAvailable, visionAvailable, busy, compact, onSelect }: {
  mode: DeepSeekPrimaryMode;
  ready: boolean;
  expertAvailable: boolean;
  visionAvailable: boolean;
  busy: boolean;
  compact: boolean;
  onSelect: (mode: DeepSeekPrimaryMode) => void;
}) {
  const label = mode === "expert" ? "专家模式" : mode === "vision" ? "识图模式" : "快速模式";
  return <section className={`ai-primary-mode${compact ? " compact" : ""}`} aria-label="对话主模式">
    <div className="ai-primary-mode-heading"><BrandLogo brand="deepseek" /><strong>{compact ? `当前：${label}` : `使用${label}开始对话`}</strong>{compact && <small>切换模式会保留当前内容并开启新对话</small>}</div>
    <div className="ai-primary-mode-tabs" role="tablist" aria-label="选择对话模式">
      <button type="button" role="tab" aria-selected={mode === "quick"} className={mode === "quick" ? "active" : ""} disabled={!ready || busy} onClick={() => onSelect("quick")}><span>ϟ</span>快速模式</button>
      <button type="button" role="tab" aria-selected={mode === "expert"} className={mode === "expert" ? "active" : ""} disabled={!ready || !expertAvailable || busy} title={expertAvailable ? "使用官网专家模式" : "官网模式区尚未识别"} onClick={() => onSelect("expert")}><span>◇</span>专家模式</button>
      <button type="button" role="tab" aria-selected={mode === "vision"} className={mode === "vision" ? "active" : ""} disabled={!ready || !visionAvailable || busy} title={visionAvailable ? "选择图片进入识图模式" : "官网附件入口尚未识别"} onClick={() => onSelect("vision")}><span>▧</span>识图模式</button>
    </div>
  </section>;
}

function AssistantMessageContent({ content, reasoning, streaming = false }: { content: string; reasoning: string; streaming?: boolean }) {
  return <>
    {reasoning && <details className="ai-reasoning" open={streaming || undefined}>
      <summary><span>{streaming && !content ? "正在思考…" : "思考过程"}</span><small>{streaming && !content ? "内容持续生成中" : "点击展开或收起"}</small></summary>
      <div className="ai-reasoning-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{reasoning}</ReactMarkdown></div>
    </details>}
    {reasoning && content && <div className="ai-final-answer-label">最终回答</div>}
    {content && <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>}
    {streaming && <i />}
  </>;
}

function statusLabel(snapshot: DeepSeekSnapshot, thinking = false) {
  if (!isTauri()) return "需要桌面端";
  if (snapshot.status === "login_required") return "需要登录";
  if (snapshot.status === "generating") return thinking ? "正在思考" : "正在回答";
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

function modesFromSnapshot(snapshot: DeepSeekSnapshot, fallback: DeepSeekModeOptions): DeepSeekModeOptions {
  return {
    deepThinking: snapshot.deepThinkingAvailable ? snapshot.deepThinkingEnabled : fallback.deepThinking,
    expertMode: snapshot.expertModeAvailable ? snapshot.expertModeEnabled : fallback.expertMode,
    smartSearch: snapshot.smartSearchAvailable ? snapshot.smartSearchEnabled : fallback.smartSearch,
  };
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    operation.then(resolve, reject).finally(() => window.clearTimeout(timer));
  });
}

function inferImageMime(file: File) {
  if (/^image\/(png|jpeg|webp|gif)$/i.test(file.type)) return file.type.toLocaleLowerCase();
  const extension = file.name.split(".").pop()?.toLocaleLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  return "";
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("图片读取结果无法识别"));
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error || "操作没有完成");
}
