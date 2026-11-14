import "./styles/work-observer.css";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FocusSession } from "../app/work-types";
import { observationSessions, observerDisplayPath, observerEvidenceLabel, observerScreenLabel, type ObserverConfig, type ObserverStatus, type WorkObservation } from "../app/work-observer-types";
import type { WorkspaceTask } from "./WorkPages";
import { Button, SelectMenu } from "./DesktopControls";
import { workObserverApi } from "./workObserverApi";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const when = (value: string) => new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function WorkObserverPage({ tasks, activeSession, onOpenTask }: { tasks: WorkspaceTask[]; activeSession: FocusSession | null; onOpenTask: (id: string) => void }) {
  const [status, setStatus] = useState<ObserverStatus | null>(null);
  const [draft, setDraft] = useState<ObserverConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const initialized = useRef(false);
  const refresh = useCallback(async () => {
    const value = await workObserverApi.status();
    setStatus(value);
    if (!initialized.current) { initialized.current = true; setDraft(value.config); }
  }, []);
  useEffect(() => {
    let active = true;
    void refresh().catch((error) => { if (active) setError(message(error)); });
    const subscription = listen("work-observer-changed", () => { if (active) void refresh().catch((error) => setError(message(error))); });
    return () => { active = false; void subscription.then((unlisten) => unlisten()); };
  }, [refresh]);

  async function run(action: () => Promise<ObserverStatus>, success = "") {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { const value = await action(); setStatus(value); setDraft(value.config); setNotice(success); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  async function pickFolder() {
    try {
      const picked = await open({ title: "选择需要追踪的工作文件夹", directory: true, multiple: false });
      if (picked && typeof picked === "string") setDraft((current) => current ? { ...current, roots: [...new Set([...current.roots, picked])].slice(0, 3) } : current);
    } catch (error) { setError(message(error)); }
  }
  const disabled = busy || Boolean(status?.busy);
  const taskOptions = tasks.filter((task) => !["done", "cancelled"].includes(task.status)).map((task) => ({ value: task.id, label: `${task.projectTitle ? `${task.projectTitle} · ` : ""}${task.title}` }));
  if (draft?.taskId && !taskOptions.some((task) => task.value === draft.taskId)) taskOptions.push({ value: draft.taskId, label: draft.taskLabel || "已关联的行动" });
  const sessions = observationSessions(status?.records ?? []);

  return <div className="workspace-scroll observer-page">
    <header className="workspace-page-heading"><div><span>自动留下工作线索 · 试用</span><h1>工作记录</h1><p>回来时，看看上次在哪个窗口、改了哪些文件。</p></div><Button variant={status?.enabled ? "secondary" : "primary"} disabled={busy || (!status?.enabled && disabled) || !draft} onClick={() => void run(async () => {
      if (status?.enabled) return workObserverApi.enable(false);
      await workObserverApi.configure(draft!);
      return workObserverApi.enable(true);
    })}>{status?.enabled ? "暂停自动观察" : "开启自动观察"}</Button></header>
    {error && <p className="observer-message observer-message--error" role="alert">{error}</p>}
    {notice && <p className="observer-message" role="status">{notice}</p>}
    <section className="observer-status" aria-live="polite"><strong>{status?.status || "正在读取工作记录…"}</strong><span>本地处理 · 无 API 费用 · 重启后自动观察关闭</span></section>
    {draft && <section className="observer-settings" aria-label="工作观察设置">
      <div className="observer-setting-grid"><label><span>关联行动（可选）</span><SelectMenu label="关联行动" disabled={disabled} value={draft.taskId || ""} options={[{ value: "", label: "暂不关联行动" }, ...taskOptions]} onChange={(id) => setDraft({ ...draft, taskId: id || null, taskLabel: taskOptions.find((task) => task.value === id)?.label || "" })} /></label>
      <label><span>自动观察间隔</span><SelectMenu label="观察间隔" disabled={disabled} value={String(draft.intervalSeconds)} options={[{ value: "60", label: "每 1 分钟（测试）" }, { value: "300", label: "每 5 分钟" }, { value: "600", label: "每 10 分钟" }, { value: "900", label: "每 15 分钟" }]} onChange={(value) => setDraft({ ...draft, intervalSeconds: Number(value) })} /></label></div>
      {activeSession?.taskId && activeSession.taskId !== draft.taskId && <Button size="small" disabled={disabled} onClick={() => setDraft({ ...draft, taskId: activeSession.taskId, taskLabel: activeSession.label })}>关联当前投入：{activeSession.label}</Button>}
      <div className="observer-toggles"><label><input type="checkbox" disabled={disabled} checked={draft.screenshot} onChange={(event) => setDraft({ ...draft, screenshot: event.target.checked })} />截取整个桌面（含其他窗口）</label><label><input type="checkbox" disabled={disabled} checked={draft.analyze} onChange={(event) => setDraft({ ...draft, analyze: event.target.checked })} />用本地 AI 整理线索</label></div>
      <label className="observer-model"><span>Ollama 模型</span><input disabled={disabled} value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} /><small>Windows 下会按需在后台启动已安装的 Ollama，无需打开它的窗口。模型需提前下载；图片识别需要支持视觉。</small></label>
      <div className="observer-folders"><strong>追踪的工作文件夹</strong>{draft.roots.length ? draft.roots.map((root) => <div key={root}><code>{observerDisplayPath(root)}</code><Button size="small" variant="quiet" disabled={disabled} onClick={() => setDraft({ ...draft, roots: draft.roots.filter((path) => path !== root) })}>移出范围</Button></div>) : <p>可以只观察屏幕。选择工作文件夹后，将增加真实文件改动依据。</p>}<Button size="small" disabled={disabled || draft.roots.length >= 3} onClick={() => void pickFolder()}>选择工作文件夹</Button><small>首次建立基线；之后记录新增、修改、删除。文本可保留改动片段，Word、PDF 等暂只记录文件变化。</small></div>
      <footer><Button disabled={disabled} onClick={() => void run(() => workObserverApi.configure(draft), "采集设置已保存")}>保存设置</Button><Button variant="primary" disabled={disabled} onClick={() => void run(async () => { await workObserverApi.configure(draft); return workObserverApi.capture(); })}>{disabled ? "正在处理…" : "观察一次（3 秒后）"}</Button></footer>
      <small>点击后可以切回正在工作的窗口；3 秒后采集。自动观察会跳过工作台自身的画面。</small>
      <p className="observer-policy">自动观察在锁屏或连续 3 分钟无操作时跳过。采样无法覆盖全部工作；文件变化不代表行动完成。记录仅保存在本机，不参与云同步，最多保留 200 条；原图保留 7 天，总量上限 250 MB。</p>
    </section>}
    <section className="observer-history" aria-label="已保存的工作片段"><h2>上次停在哪里</h2>{sessions.length === 0 && <div className="observer-empty"><strong>还没有工作记录</strong><p>先点“观察一次”查看采集效果，再开启自动观察。工作时让应用留在托盘即可。</p></div>}{sessions.map((session, index) => <details className="observer-session" key={session.id} open={index === 0}><summary><strong>{session.records[0].taskLabel || "未关联行动的工作片段"}</strong><span>{when(session.records[session.records.length - 1].capturedAt)} — {when(session.records[0].capturedAt)} · {session.records.length} 条观察</span></summary>{session.records.map((record) => <ObservationCard key={record.id} record={record} onOpenTask={onOpenTask} />)}</details>)}</section>
  </div>;
}

function ObservationCard({ record, onOpenTask }: { record: WorkObservation; onOpenTask: (id: string) => void }) {
  const [image, setImage] = useState<string | null>(null);
  const [imageOpen, setImageOpen] = useState(false);
  const [imageFullSize, setImageFullSize] = useState(false);
  const [imageError, setImageError] = useState("");
  const [imageBusy, setImageBusy] = useState(false);
  async function showImage() {
    if (imageOpen) { setImageOpen(false); return; }
    setImageBusy(true); setImageError("");
    try { const value = image ?? await workObserverApi.image(record.id); setImage(value); setImageOpen(Boolean(value)); if (!value) setImageError("原图已按保存期限或容量上限清理。"); }
    catch (error) { setImageError(message(error)); }
    finally { setImageBusy(false); }
  }
  const cited = (ids: string[]) => ids.map((id) => observerEvidenceLabel(id, record)).join("、");
  const coverage = record.analysisCoverage;
  const currentAnalysis = record.analysis?.version === 2 ? record.analysis : null;
  return <article className="observer-record"><header><strong>{when(record.capturedAt)}</strong><span>{record.trigger === "manual" ? "手动观察" : "自动观察"} · {(record.elapsedMs / 1000).toFixed(1)} 秒</span>{record.taskId && <Button size="small" variant="quiet" onClick={() => onOpenTask(record.taskId!)}>查看行动</Button>}</header>
    <p className="observer-window"><span>前台窗口</span><strong>{record.windowTitle || "未读取到窗口标题"}</strong><small>{record.application}</small></p>
    {record.context && <div className="observer-continuation"><h3>接续位置</h3><p>最后窗口：{record.windowTitle || "未读取到窗口标题"}</p>{currentAnalysis?.resumeLocation && <p><span>文件原文线索</span>{cited([currentAnalysis.resumeLocation.evidenceId])}<q>{currentAnalysis.resumeLocation.quote}</q></p>}{currentAnalysis?.screenContent?.location && <p><span>屏幕中的位置（AI）</span>{currentAnalysis.screenContent.location}</p>}{Boolean(record.pendingMentions?.length) && <div><strong>原文提及的待办</strong><small>来自保存后的文件片段；原文的状态尚未经过运行或质量验证。</small>{record.pendingMentions!.map((item, index) => <p key={index}><q>{item.quote}</q><small>依据：{cited([item.evidenceId])}</small></p>)}</div>}{!currentAnalysis?.resumeLocation && !currentAnalysis?.screenContent?.location && !record.pendingMentions?.length && <small>暂未提取到明确的文件或段落位置；可以核对下方文件片段和原图。</small>}</div>}
    {Boolean(record.context?.length) && <details className="observer-context"><summary>近期 {record.context!.length} 次采样 · 时间线索</summary><p>这些是较早的窗口与文件采样，不表示所有操作都发生在同一工作中。</p>{[...record.context!].reverse().map((sample) => <div key={sample.id}><strong>{when(sample.capturedAt)} · {sample.windowTitle || sample.application}</strong>{sample.files.map((file) => <small key={file.evidenceId}>{({ created: "新增", modified: "修改", deleted: "删除" } as Record<string, string>)[file.kind] || "变化"} · {observerDisplayPath(file.path)}</small>)}{sample.omittedFiles > 0 && <small>另有 {sample.omittedFiles} 份文件变化未放入近期摘录。</small>}</div>)}</details>}
    {coverage && <p className="observer-coverage">本次 {coverage.totalFileChanges} 份文件变化，{coverage.includedFileIndices.length} 份进入 AI 分析{coverage.omittedFileCount > 0 ? `；另有 ${coverage.omittedFileCount} 份未进入分析` : ""}。{coverage.truncatedFileIndices.length > 0 && `${coverage.truncatedFileIndices.length} 份仅使用部分摘录。`}{coverage.unreadableFileIndices.length > 0 && `${coverage.unreadableFileIndices.length} 份没有可引用的保存后正文（如删除或非文本文件）。`}近期采样 {coverage.contextRecordIds.length} 次。已保存的文件变化可在下方核对。</p>}
    {record.fileChanges.length > 0 && <div className="observer-evidence"><h3>文件变化 · 程序确认</h3>{record.fileChanges.map((file, index) => <details key={`${file.path}:${index}`}><summary><span>{({ created: "新增", modified: "修改", deleted: "删除" })[file.kind]}</span><code title={observerDisplayPath(file.path)}>{observerDisplayPath(file.path)}</code></summary>{file.before !== null || file.after !== null ? <div className="observer-diff">{file.before !== null && <div><strong>改动前</strong><pre>{file.before || "（空）"}</pre></div>}{file.after !== null && <div><strong>改动后</strong><pre>{file.after || "（空）"}</pre></div>}{file.excerptLimited && <small>改动较长，仅展示部分片段。</small>}</div> : <p>仅能确认文件变化，未读取文件正文。</p>}</details>)}</div>}
    {currentAnalysis ? <div className="observer-ai"><h3>AI 草稿 · 按来源整理</h3>{currentAnalysis.screenContent && <div className="observer-screen-content"><strong>{observerScreenLabel(currentAnalysis.screenContent.kind)}</strong><p>{currentAnalysis.screenContent.text}<small>依据：本次整屏截图</small></p></div>}{Boolean(currentAnalysis.fileNotes?.length) && <div><strong>文件内容整理 · 不代表任务完成</strong>{currentAnalysis.fileNotes!.map((note, index) => <p key={index}>{note.text}<small>依据：{cited([note.evidenceId])}</small><q>{note.quote}</q></p>)}</div>}{!currentAnalysis.screenContent && !currentAnalysis.fileNotes?.length && <p>没有足够清晰的内容可整理，原始记录已保留。</p>}{currentAnalysis.uncertainties.length > 0 && <div className="observer-uncertainty"><strong>仍需核对的疑问（AI）</strong>{currentAnalysis.uncertainties.map((note, index) => <p key={index}>{note}</p>)}</div>}</div> : record.analysis && <div className="observer-ai"><h3>早期 AI 草稿 · 未按来源分类</h3>{record.analysis.observations.length ? record.analysis.observations.map((claim, index) => <p key={index}>{claim.text}<small>依据：{cited(claim.evidenceIds)}</small></p>) : <p>没有足够清晰的内容可整理。</p>}{record.analysis.resumeHint && <p className="observer-resume"><strong>接续线索</strong>{record.analysis.resumeHint.text}<small>依据：{cited(record.analysis.resumeHint.evidenceIds)}</small></p>}{record.analysis.uncertainties.map((note, index) => <p className="observer-uncertainty" key={index}>{note}</p>)}</div>}
    {record.analysisError && <p className="observer-message">{record.analysisError}</p>}
    {record.notes.map((note, index) => <p className="observer-note" key={index}>{note}</p>)}
    {record.screenshot && <Button size="small" disabled={imageBusy} onClick={() => void showImage()}>{imageBusy ? "读取中…" : imageOpen ? "收起原图" : "核对整屏截图"}</Button>}{imageError && <p>{imageError}</p>}{imageOpen && image && <div className="observer-image"><Button size="small" onClick={() => setImageFullSize(!imageFullSize)}>{imageFullSize ? "适应宽度" : "按原尺寸查看"}</Button><div className="observer-image-scroll" tabIndex={0} aria-label="整屏原图，可滚动查看"><img className={imageFullSize ? "observer-image-native" : undefined} src={image} alt={`${when(record.capturedAt)}的整屏工作截图`} /></div></div>}
  </article>;
}
