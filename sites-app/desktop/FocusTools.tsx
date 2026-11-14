import "./styles/focus-tools.css";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import type { WorkRepository } from "../app/data/work-repository";
import type { WorkspacePreferencesRepository } from "../app/data/workspace-preferences-repository";
import { FOCUS_REMINDER_INTERVALS } from "../app/focus-reminder";
import type { FocusSession } from "../app/work-types";
import { Button } from "./DesktopControls";
import { formatFocusDuration } from "./focus-format";

type Reminder = { sessionId: string; body: string };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

function dateTimeInput(value: string | number) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function FocusDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); };
  }, []);
  return <dialog ref={ref} className="focus-tools-dialog" aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
  }}>
    <header><h2>{title}</h2><Button variant="ghost" iconOnly aria-label={`关闭${title}`} onClick={onClose}>×</Button></header>
    {children}
  </dialog>;
}

function FocusEditor({ session, repository, onClose, onSaved }: {
  session: FocusSession; repository: WorkRepository; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const active = !session.endedAt;
  const [startedAt, setStartedAt] = useState(() => dateTimeInput(session.startedAt));
  const [endedAt, setEndedAt] = useState(() => dateTimeInput(session.endedAt || Date.now()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const startTime = active ? new Date(session.startedAt).getTime() : new Date(startedAt).getTime();
  const endTime = new Date(endedAt).getTime();
  const valid = Number.isFinite(startTime) && Number.isFinite(endTime) && endTime > startTime && endTime <= Date.now();

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true); setError("");
    try {
      if (active) await repository.stopSession({ id: session.id, endedAt: new Date(endTime).toISOString() });
      else await repository.updateSession({ id: session.id, startedAt: new Date(startTime).toISOString(), endedAt: new Date(endTime).toISOString() });
      await onSaved();
      onClose();
    } catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  }

  return <FocusDialog title={active ? "刚才已结束" : "修改投入记录"} onClose={() => { if (!busy) onClose(); }}>
    <p className="focus-tools-subject">{session.label}</p>
    <form onSubmit={(event) => void save(event)}>
      {active ? <p>开始于 {new Date(session.startedAt).toLocaleString("zh-CN")}。选择实际结束时间，多计的部分会扣除。</p>
        : <label><span>开始时间</span><input type="datetime-local" step={1} required max={dateTimeInput(Date.now())} value={startedAt} disabled={busy} onChange={(event) => setStartedAt(event.target.value)} /></label>}
      {active && <div className="focus-tools-quick-times">{[10, 30, 60].map((minutes) => <Button key={minutes} size="small" disabled={busy || Date.now() - minutes * 60_000 <= startTime} onClick={() => { setEndedAt(dateTimeInput(Date.now() - minutes * 60_000)); setError(""); }}>{minutes} 分钟前结束</Button>)}</div>}
      <label><span>实际结束时间</span><input type="datetime-local" step={1} required min={dateTimeInput(startTime)} max={dateTimeInput(Date.now())} value={endedAt} disabled={busy} onChange={(event) => setEndedAt(event.target.value)} /></label>
      <p className="focus-tools-preview">{valid ? `本次记录 ${formatFocusDuration(Math.round((endTime - startTime) / 1000))}` : "结束时间必须晚于开始时间，且不能晚于当前时间。"}</p>
      {error && <p className="focus-tools-error" role="alert">{error}</p>}
      <footer><Button disabled={busy} onClick={onClose}>取消</Button><Button variant="primary" type="submit" disabled={busy || !valid}>{busy ? "正在保存…" : active ? "暂停并记录" : "保存修改"}</Button></footer>
    </form>
  </FocusDialog>;
}

export function FocusTools({ activeSession, repository, preferencesRepository, editorSession, onEdit, historyOpen, onCloseHistory, onChanged, onMessage }: {
  activeSession: FocusSession | null;
  repository: WorkRepository;
  preferencesRepository: WorkspacePreferencesRepository;
  editorSession: FocusSession | null;
  onEdit: (session: FocusSession | null) => void;
  historyOpen: boolean;
  onCloseHistory: () => void;
  onChanged: () => Promise<void>;
  onMessage: (message: string) => void;
}) {
  const [reminder, setReminder] = useState<Reminder | null>(null);
  const [minutes, setMinutes] = useState(45);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [preferenceBusy, setPreferenceBusy] = useState(false);
  const [records, setRecords] = useState<FocusSession[]>([]);
  const [limit, setLimit] = useState(50);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [testMessage, setTestMessage] = useState("");
  const [correctionRequest, setCorrectionRequest] = useState<string | null>(null);

  const loadRecords = useCallback(async () => {
    setLoading(true);
    try { setRecords(await repository.listSessions("", limit)); setError(""); }
    catch (error) { setError(errorText(error)); }
    finally { setLoading(false); }
  }, [repository, limit]);

  useEffect(() => {
    void preferencesRepository.getFocusReminderMinutes().then((value) => { setMinutes(value); setPreferencesReady(true); }).catch((error) => onMessage(errorText(error)));
  }, [preferencesRepository, onMessage]);
  useEffect(() => { if (historyOpen) void loadRecords(); }, [historyOpen, loadRecords, activeSession?.id]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const receive = (payload: Reminder | null) => { if (!disposed && payload) setReminder(payload); };
    const subscription = listen<Reminder>("focus-reminder-due", ({ payload }) => receive(payload));
    const pending = () => { void invoke<Reminder | null>("pending_focus_reminder").then(receive).catch((error) => onMessage(`无法读取投入提醒：${errorText(error)}`)); };
    void subscription.then(() => { if (!disposed) pending(); }).catch((error) => onMessage(`无法接收投入提醒：${errorText(error)}`));
    window.addEventListener("focus", pending);
    return () => { disposed = true; window.removeEventListener("focus", pending); void subscription.then((unlisten) => unlisten()).catch(() => {}); };
  }, [onMessage]);

  useEffect(() => {
    if (!isTauri()) return;
    const subscriptions = [
      listen<string>("focus-reminder-error", ({ payload }) => onMessage(payload)),
      listen<string>("focus-reminder-acknowledged", () => setReminder(null)),
      listen<string>("focus-reminder-correct", ({ payload }) => setCorrectionRequest(payload)),
      listen<string>("focus-session-changed", () => { void onChanged().then(() => setReminder(null)).catch((error) => onMessage(errorText(error))); }),
    ];
    for (const subscription of subscriptions) void subscription.catch((error) => onMessage(`无法接收 Windows 提醒操作：${errorText(error)}`));
    return () => { for (const subscription of subscriptions) void subscription.then((unlisten) => unlisten()).catch(() => {}); };
  }, [onMessage, onChanged]);

  useEffect(() => {
    if (correctionRequest && activeSession?.id === correctionRequest) {
      onEdit(activeSession);
      setCorrectionRequest(null);
      setReminder(null);
    }
  }, [correctionRequest, activeSession, onEdit]);

  async function testReminder() {
    setTestBusy(true);
    setTestMessage("5 秒后发送 Windows 测试提醒，现在可以切换到其他窗口或最小化工作台。");
    try {
      const delivery = await invoke<string>("test_focus_reminder");
      setTestMessage(delivery === "dialog" ? "Windows 通知当前被禁用，已改用独立的 Windows 提醒弹窗。工作台最小化时仍会显示。" : "Windows 已接收测试提醒。如未看到弹窗，请检查 Windows 的通知和勿扰设置。");
    } catch (error) { setTestMessage(errorText(error)); }
    finally { setTestBusy(false); }
  }

  useEffect(() => {
    if (!preferencesReady || !activeSession || minutes === 0 || !isTauri()) return;
    void isPermissionGranted().then(async (granted) => { if (!granted) await requestPermission(); }).catch(() => {});
  }, [activeSession?.id, minutes, preferencesReady]);

  async function saveInterval(value: number) {
    setPreferenceBusy(true);
    try {
      setMinutes(await preferencesRepository.saveFocusReminderMinutes(value));
      if (value === 0) setReminder(null);
      onMessage(value === 0 ? "投入提醒已关闭。" : `每 ${value} 分钟提醒一次。`);
    } catch (error) { setError(errorText(error)); }
    finally { setPreferenceBusy(false); }
  }

  async function continueFocus() {
    if (!activeSession || busy) return;
    setBusy(true);
    try { await invoke("acknowledge_focus_reminder", { sessionId: activeSession.id }); setReminder(null); }
    catch (error) { onMessage(`无法延后提醒：${errorText(error)}`); }
    finally { setBusy(false); }
  }

  async function pauseFocus() {
    if (!activeSession || busy) return;
    setBusy(true);
    try { await repository.stopSession(activeSession.id); await onChanged(); setReminder(null); onMessage("投入已暂停并记录。"); }
    catch (error) { onMessage(errorText(error)); }
    finally { setBusy(false); }
  }

  async function deleteRecord(id: string) {
    if (busy) return;
    setBusy(true);
    try { await repository.deleteSession(id); setDeleteId(null); await onChanged(); await loadRecords(); onMessage("投入记录已删除，累计时间已更新。"); }
    catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  }

  async function saved() {
    await onChanged();
    if (historyOpen) await loadRecords();
    if (editorSession?.id === reminder?.sessionId) setReminder(null);
    onMessage("投入记录已修正，累计时间已更新。");
  }

  return <>
    {reminder && reminder.sessionId === activeSession?.id && activeSession && minutes > 0 && <aside className="focus-reminder-prompt" role="status" aria-label="投入提醒">
      <strong>还在投入吗？</strong><p>{reminder.body}</p><div><Button size="small" disabled={busy} onClick={() => void continueFocus()}>继续投入</Button><Button size="small" disabled={busy} onClick={() => void pauseFocus()}>现在暂停</Button><Button size="small" disabled={busy} onClick={() => onEdit(activeSession)}>刚才已结束</Button></div>
    </aside>}
    {historyOpen && <FocusDialog title="投入记录" onClose={() => { if (!busy) { setDeleteId(null); onCloseHistory(); } }}>
      <section className="focus-tools-preferences"><strong>Windows 弹窗提醒</strong><p>投入期间在 Windows 桌面弹出提醒，最小化或收起到托盘也会提醒。Windows 禁用通知时，改用独立的原生提醒弹窗。可直接继续或暂停；修正结束时间时才打开工作台。</p><div>{FOCUS_REMINDER_INTERVALS.map((value) => <Button key={value} size="small" variant={minutes === value ? "primary" : "secondary"} aria-pressed={minutes === value} disabled={preferenceBusy} onClick={() => void saveInterval(value)}>{value ? `${value} 分钟` : "关闭"}</Button>)}</div><Button size="small" disabled={testBusy} onClick={() => void testReminder()}>{testBusy ? "等待测试提醒…" : "发送 Windows 测试提醒"}</Button>{testMessage && <p role="status">{testMessage}</p>}</section>
      {error && <p className="focus-tools-error" role="alert">{error}</p>}
      <div className="focus-tools-records">{records.map((session) => <article key={session.id}>
        <div><strong>{session.label}</strong><p>{new Date(session.startedAt).toLocaleString("zh-CN")}</p><small>{session.endedAt ? `结束于 ${new Date(session.endedAt).toLocaleString("zh-CN")} · ${formatFocusDuration(session.durationSeconds)}` : "正在投入"}</small></div>
        {deleteId === session.id ? <div className="focus-tools-delete-confirm"><p>删除这段记录，并扣除对应投入时间？</p><Button size="small" disabled={busy} onClick={() => setDeleteId(null)}>取消</Button><Button size="small" variant="danger" disabled={busy} onClick={() => void deleteRecord(session.id)}>确认删除</Button></div>
          : <div className="focus-tools-record-actions"><Button size="small" disabled={busy} onClick={() => onEdit(session)}>{session.endedAt ? "修改" : "刚才已结束"}</Button>{session.endedAt && <Button size="small" variant="ghost" disabled={busy} onClick={() => setDeleteId(session.id)}>删除</Button>}</div>}
      </article>)}{!records.length && !loading && <p>还没有投入记录。开始投入后，记录会显示在这里。</p>}</div>
      {loading && <p role="status">正在读取记录…</p>}
      {records.length >= limit && limit < 2000 && <Button disabled={loading} onClick={() => setLimit((value) => value + 50)}>查看更多记录</Button>}
      {limit >= 2000 && records.length >= limit && <p>当前显示最近 2000 段投入记录。</p>}
    </FocusDialog>}
    {editorSession && <FocusEditor key={editorSession.id} session={editorSession} repository={repository} onClose={() => onEdit(null)} onSaved={saved} />}
  </>;
}
