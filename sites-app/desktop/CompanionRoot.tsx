import "./companion-entry.css";
import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { asabaJobLabels, companionReadout, type AsabaDelegation, type AsabaJob, type AsabaObservation, type AsabaRecap, type CompanionStatus } from "../app/companion-types";
import { companionApi, type AsabaStage } from "./companionApi";
import { Button, SelectMenu } from "./DesktopControls";
import { AsabaJobCard, AsabaShotPreview } from "./AsabaDetails";
import { AsabaDelegationForm, type DelegationSource } from "./AsabaDelegation";
import { useAsabaSpeech } from "./useAsabaSpeech";
import { AsabaFocusPanel, useAsabaFocus } from "./AsabaFocus";
import { AsabaSettings } from "./AsabaSettings";
import { useAsabaInteraction } from "./useAsabaInteraction";
import { useAsabaPersonality } from "./useAsabaPersonality";
import { AsabaCharacter } from "./AsabaCharacter";
import { AsabaPetActivation } from "./asaba-pet-activation";
const AiMarkdown = lazy(async () => ({ default: (await import("./AiMarkdown")).AiMarkdown }));

type Page = "home" | "note" | "saved" | "recap" | "settings" | "delegate" | "jobs" | "news" | "focus";
type Draft = { id: string; text: string; url: string; projectId: string };

const blank = (): Draft => ({ id: crypto.randomUUID(), text: "", url: "", projectId: "" });
const clock = (value: string) => new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
const kindLabel: Record<string, string> = { app: "前台应用", screen: "画面线索", codex: "你的 Codex 会话", note: "随手记", worker: "浅羽代办" };
const active = (job: AsabaJob) => ["queued", "running", "recovering"].includes(job.state);
const initialStage: AsabaStage = { expanded: false, walking: false, direction: 1, mood: "idle", layout: { petX: 0, petY: 0, bubbleX: 0, bubbleY: 0, tailY: 80, bubbleLeft: true } };
const movementKey = "asaba.idle-motion";

function AsabaIcon({ name }: { name: "focus" | "delegate" | "note" | "voice" }) {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "focus" && <><circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4V8Z"/></>}
    {name === "delegate" && <><rect x="3" y="7" width="18" height="13" rx="3"/><path d="M8 7V4h8v3m-8 7 3 3 5-6"/></>}
    {name === "note" && <><path d="M12 4H5v16h14v-7M8 16l2.5-.5 8-8-2-2-8 8L8 16Z"/><path d="m16.5 5.5 1.8-1.8 2 2-1.8 1.8"/></>}
    {name === "voice" && <><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5.5 11v1a6.5 6.5 0 0 0 13 0v-1M12 19v3m-3 0h6"/></>}
  </svg>;
}

export default function CompanionRoot() {
  const [stage, setStage] = useState(initialStage);
  const { expanded, layout } = stage;
  const [page, setPage] = useState<Page>("home");
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [observation, setObservation] = useState<AsabaObservation | null>(null);
  const [jobs, setJobs] = useState<AsabaJob[]>([]);
  const [recap, setRecap] = useState<AsabaRecap | null>(null);
  const [recapBusy, setRecapBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(blank);
  const [includeApp, setIncludeApp] = useState(false);
  const [includeShot, setIncludeShot] = useState(false);
  const [delegation, setDelegation] = useState<AsabaDelegation | null>(null);
  const [notice, setNotice] = useState("");
  const [ttsPhase, setTtsPhase] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [roam, setRoam] = useState(() => localStorage.getItem(movementKey) !== "off");
  const [smalltalk, setSmalltalk] = useState(() => localStorage.getItem("asaba.smalltalk") !== "off");
  const [focusSuggestions, setFocusSuggestions] = useState(() => localStorage.getItem("asaba.focus-suggestions") !== "off");
  const [dictationPaused, setDictationPaused] = useState(false);
  const [dictationPreview, setDictationPreview] = useState("");
  const [dictationReady, setDictationReady] = useState(false);
  const [noteOptions, setNoteOptions] = useState(false);
  const [savedNote, setSavedNote] = useState<DelegationSource | null>(null);
  const dictationId = useRef("");
  const { audio, progress, speak, retry: retrySpeech, stop: stopSpeech, pause: pauseSpeech, toggle: toggleSpeech } = useAsabaSpeech(setNotice);
  const focus = useAsabaFocus(status?.context, focusSuggestions && Boolean(observation?.enabled));
  const interaction = useAsabaInteraction();
  const voiceBusy = busy || listening || audio !== "off";
  const personality = useAsabaPersonality({ mood: stage.mood, reaction: interaction.reaction, enabled: roam, smalltalk,
    quiet: expanded || voiceBusy || Boolean(status?.context.activeFocus) || Boolean(focus.activity && (!focus.activity.available || focus.activity.idleSeconds >= 180)),
    resultId: jobs.find(job => ["review", "completed"].includes(job.state))?.id });
  const speechActive = Boolean(personality.moment?.text && smalltalk && !expanded && !voiceBusy);
  const operation = useRef(false);
  const recapRequest = useRef(0);
  const recapPending = useRef(false);
  const hearing = useRef(false);
  const dictationVersion = useRef(0);
  const draftText = useRef<HTMLTextAreaElement>(null);
  const bubble = useRef<HTMLElement>(null);
  const press = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);
  const petActivation = useRef(new AsabaPetActivation());
  const voiceAction = useRef<() => void>(() => {});

  function error(value: unknown) { setNotice(value instanceof Error ? value.message : String(value)); }
  function refresh() { void companionApi.status().then(setStatus).catch(error); }
  function refreshObservation() { void companionApi.observation().then(setObservation).catch(error); }
  function refreshJobs() { void companionApi.jobs().then(setJobs).catch(error); }
  async function endFocus() {
    const session = status?.context.activeFocus;
    if (!session) return;
    await companionApi.focus({ id: crypto.randomUUID(), operation: "stop", sessionId: session.id });
    setStatus(await companionApi.status());
    setNotice("这次投入已经记录。");
  }
  async function openNews() {
    setPage("news");
    setNotice("");
    await companionApi.refreshContext();
    const next = await companionApi.status();
    setStatus(next);
  }
  async function pauseDictation() {
    dictationVersion.current += 1;
    await companionApi.dictation("stop");
    setDictationPaused(true);
    setNotice("");
  }
  useEffect(() => {
    refresh(); refreshObservation(); refreshJobs();
    const subscriptions = [
      listen("companion-changed", refresh),
      listen("asaba-observation-changed", refreshObservation),
      listen("asaba-jobs-changed", refreshJobs),
      listen<AsabaStage>("asaba-stage", ({ payload }) => setStage(payload)),
      listen("asaba-voice-shortcut", () => voiceAction.current()),
      listen<string>("asaba-tts-phase", ({ payload }) => setTtsPhase(payload)),
      listen<string>("companion-action-result", ({ payload }) => setNotice(payload)),
      listen<DelegationSource>("asaba-prepare-note", ({payload}) => { void prepare(payload).catch(error); }),
      listen<{id: string; text?: string; ready?: boolean; warning?: string}>("asaba-dictation-text", ({payload}) => {
        if (payload.id !== dictationId.current) return;
        if (payload.text !== undefined) setDictationPreview(payload.text);
        if (payload.ready) setDictationReady(true);
        if (payload.warning) setNotice(payload.warning);
      }),
    ];
    void Promise.all(subscriptions).then(() => companionApi.stage()).catch(error);
    return () => { for (const subscription of subscriptions) void subscription.then(stop => stop()); };
  }, []);
  useEffect(() => { if (expanded) refreshObservation(); }, [expanded]);
  useEffect(() => { void companionApi.stage({ speech: speechActive }).catch(error); }, [speechActive]);
  useEffect(() => { if (!expanded) pauseSpeech(); }, [expanded]);
  useEffect(() => () => { void companionApi.dictation("stop"); }, []);
  useEffect(() => { if (expanded && page === "note") draftText.current?.focus(); }, [expanded, page]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => void companionApi.stage({ reducedMotion: media.matches || !roam }).catch(error);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [roam]);
  useEffect(() => {
    void companionApi.stage({ busy: busy || listening || ["preparing", "playing", "paused"].includes(audio) }).catch(error);
  }, [busy, listening, audio]);
  useEffect(() => {
    const node = bubble.current;
    if (!expanded || !node) return;
    let lastSize = "";
    const observer = new ResizeObserver(() => {
      const width = node.offsetWidth;
      const height = node.offsetHeight;
      const key = `${width}x${height}`;
      if (key !== lastSize && width && height) {
        lastSize = key;
        void companionApi.stage({ width, height }).catch(error);
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded]);

  async function run(action: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true); setNotice("");
    try { await action(); } catch (err) { error(err); }
    finally { operation.current = false; setBusy(false); }
  }
  async function openRecap(force = false, readAloud = false) {
    setPage("recap");
    setNotice("");
    const date = new Date();
    const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    if (!force && recap?.day === today) {
      if (readAloud) void speak(recap.text);
      return;
    }
    if (recapPending.current) return;
    recapPending.current = true;
    const request = ++recapRequest.current;
    setRecapBusy(true);
    try {
      const next = await companionApi.recap(force);
      if (request !== recapRequest.current) return;
      setRecap(next);
      if (readAloud) void speak(next.text);
    } catch (err) {
      if (request === recapRequest.current) error(err);
    } finally {
      if (request === recapRequest.current) {
        recapPending.current = false;
        setRecapBusy(false);
      }
    }
  }
  async function cancelRecap() {
    ++recapRequest.current;
    try {
      await companionApi.cancelRecap();
      setNotice("已取消整理。");
    } catch (err) { error(err); }
    finally { recapPending.current = false; setRecapBusy(false); }
  }
  async function prepare(value: DelegationSource) {
    const repository = value.repository || (value.projectId && await companionApi.repository(value.projectId)) || "";
    setNotice("");
    bubble.current?.querySelector(".asaba-body")?.scrollTo(0, 0);
    setDelegation({ ...value, repository, requestId: crypto.randomUUID(), agent: value.agent ?? "codex", workspaceMode: value.workspaceMode ?? "copy" });
    setPage("delegate");
  }
  async function dictate() {
    if (hearing.current || operation.current) return;
    hearing.current = true;
    setListening(true); setNotice(""); setDictationPreview(""); setDictationReady(false);
    setPage("note");
    try {
      stopSpeech();
      setDictationPaused(false);
      const version = ++dictationVersion.current;
      dictationId.current = crypto.randomUUID();
      const text = (await companionApi.dictation("listen", dictationId.current)).trim();
      setDictationPreview("");
      if (version !== dictationVersion.current) {
        if (text) {
          setDraft(current => ({ ...current, text: [current.text, text].filter(Boolean).join("\n").slice(0, 4000) }));
          setPage("note");
        }
        return;
      }
      if (!text) { setNotice("没听清，可以再说一次。"); return; }
      setNotice("");
      if (/^(浅羽[，, ]*)?(听今天|讲讲今天|今天做了什么)[。！!？? ]*$/.test(text)) {
        void openRecap(false, true);
      } else if (/^(浅羽[，, ]*)?帮我(?:排查|查|修)(?:一下)?这个(?:\s*bug|问题)[。！!？? ]*$/i.test(text)) {
        setNotice("先保存笔记，再从笔记整理委托说明。");
      } else {
        const instruction = /^(浅羽[，, ]*)?(记一下|记个笔记|帮我记)[。！!？?，, ]*$/.test(text);
        setDraft(current => instruction ? current : { ...current, text: [current.text, text].filter(Boolean).join("\n").slice(0, 4000) });
        setPage("note");
        setNotice("");
      }
    } catch (err) { error(err); }
    finally { hearing.current = false; setListening(false); }
  }
  voiceAction.current = () => listening ? void pauseDictation().catch(error) : void dictate();

  async function save() {
    const noteId = await companionApi.saveNote({
      ...draft,
      application: includeApp ? observation?.sourceApplication || undefined : undefined,
      shotId: includeShot ? observation?.sourceShot?.id : undefined,
    });
    const text = draft.text.trim();
    const next = { noteId, projectId: draft.projectId, title: text.split("\n")[0].slice(0, 100), description: text, repository: "" };
    setDraft(blank()); setIncludeApp(false); setIncludeShot(false);
    setSavedNote(next); setDictationPreview(""); setDictationPaused(false);
    setPage("saved");
  }

  const interactiveState = personality.moment?.mood || (interaction.reaction === "pat" ? "patted"
    : interaction.reaction === "greet" ? "greeting"
    : interaction.reaction === "watch" ? "attentive"
    : stage.mood);
  const petState = listening && !dictationPaused ? "listening" : audio === "playing" ? "reading" : busy || audio === "preparing" ? "focused" : interactiveState;
  const expression = { idle: "", curious: "?", excited: "✦", focused: "···", listening: "◌", reading: "♪", walking: "", cuddle: "♡", cheer: "✦", sleepy: "☾", spin: "♪" }[petState] || "";
  const tone = listening && !dictationPaused ? "我在听" : audio === "preparing" ? ttsPhase || "正在合成语音" : audio === "playing" ? "正在说话" : audio === "paused" ? "朗读已暂停" : smalltalk && personality.moment?.text ? personality.moment.text : stage.mood === "curious" ? "好奇地看看" : stage.mood === "excited" ? "来了精神" : stage.mood === "focused" ? "认真陪你" : "我在这儿";
  const canSave = Boolean(draft.text.trim() || draft.url.trim());
  const pages: Record<Page, string> = { home: "浅羽", note: "随手记", saved: "笔记已保存", recap: "今日回顾", settings: "浅羽设置", delegate: "委托说明", jobs: "委托", news: "每日早报", focus: "开始投入" };
  function closeBubble() {
    pauseSpeech();
    if (!(page === "note" && canSave) && page !== "delegate" && page !== "focus" && !busy && !listening) {
      setPage("home");
      setNotice("");
    }
    return companionApi.window(false).catch(error);
  }
  return <main className="asaba-stage" data-state={petState} data-expanded={expanded} data-pointer-resting={interaction.resting}
    onKeyDown={event => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (listening) { event.preventDefault(); void pauseDictation().catch(error); }
      else if (expanded) closeBubble();
    }}>
    <Button className="asaba-pet-button" variant="ghost" aria-label={expanded ? "收起浅羽气泡" : "打开浅羽气泡"} aria-expanded={expanded}
      style={{ left: layout.petX, top: layout.petY }}
      onContextMenu={event => { event.preventDefault(); interaction.wake(6500); personality.play(); }}
      onPointerEnter={interaction.enter}
      onPointerDown={event => { if (event.button === 0) { interaction.freeze(); press.current = { x: event.screenX, y: event.screenY }; dragged.current = false; } }}
      onPointerMove={event => {
        interaction.move(event);
        const start = press.current;
        if (start && (event.buttons & 1) !== 0 && Math.hypot(event.screenX - start.x, event.screenY - start.y) > 5) {
          press.current = null;
          dragged.current = true;
          interaction.leave();
          void getCurrentWindow().startDragging().catch(error);
        }
      }}
      onPointerUp={() => { press.current = null; interaction.release(); }}
      onPointerCancel={() => { press.current = null; interaction.leave(); }}
      onPointerLeave={() => { press.current = null; interaction.leave(); }}
      onDoubleClick={event => event.preventDefault()}
      onClick={async event => {
        if (dragged.current && event.detail) { dragged.current = false; return; }
        if (!petActivation.current.begin(event.detail, performance.now())) return;
        interaction.respond("greet");
        try {
          if (expanded) await closeBubble();
          else await companionApi.window(true).catch(error);
        } finally { petActivation.current.finish(); }
      }}>
      <span className="asaba-follow" ref={interaction.follow} aria-hidden="true">
        <AsabaCharacter state={petState} animate={roam} pointer={interaction.point} />
      </span>
      {interaction.reaction === "pat" && <span className="asaba-affection" aria-hidden="true"><i>♡</i><i>♡</i><i>✧</i></span>}
      {personality.moment && !voiceBusy && <span className="asaba-sparkles" data-accent={personality.moment.accent} key={personality.moment.id} aria-hidden="true"><i>{personality.moment.symbol}</i><i>✧</i></span>}
      {expression && <span className="asaba-emotion" aria-hidden="true">{expression}</span>}
      {!expanded && status?.context.activeFocus && <span className="asaba-focus-dot" aria-label="正在投入" />}
      {!expanded && !status?.context.activeFocus && focus.suggestion && <span className="asaba-focus-dot suggestion" aria-label="可以开始记录投入" />}
    </Button>
    {speechActive && stage.speech && <div className="asaba-smalltalk" data-side={layout.bubbleLeft ? "left" : "right"} data-accent={personality.moment?.accent}
      style={{ left: layout.bubbleX, top: layout.bubbleY, "--asaba-tail-y": `${layout.tailY}px` } as CSSProperties}>
      <span aria-hidden="true">{personality.moment?.symbol}</span><p>{personality.moment?.text}</p>
    </div>}
    <aside hidden={!expanded} ref={bubble} className="asaba-bubble" data-page={page} data-side={layout.bubbleLeft ? "left" : "right"}
      style={{ left: layout.bubbleX, top: layout.bubbleY, "--asaba-tail-y": `${layout.tailY}px`, "--asaba-cap": `${Math.max(200, window.screen.availHeight - 24)}px` } as CSSProperties}
      aria-label={pages[page]}>
    <header className="asaba-heading">
      <span className="asaba-feather" aria-hidden="true">✦</span>
      <div><strong>{pages[page]}</strong><small>{tone}</small></div>
      {page !== "home" && <Button variant="ghost" size="small" onClick={() => { setPage("home"); setNotice(""); }}>返回</Button>}
      <Button variant="ghost" size="small" iconOnly aria-label="收起气泡" onClick={closeBubble}>×</Button>
    </header>
    <section className="asaba-body">
      {page === "home" && <>
        <div className="asaba-home-actions">
          <Button className="asaba-primary" variant="primary" disabled={busy} onClick={() => status?.context.activeFocus ? void run(endFocus) : setPage("focus")}><AsabaIcon name="focus" />{status?.context.activeFocus ? "结束投入" : "开始投入"}</Button>
          <Button onClick={() => { setPage("note"); setNotice(""); }}><AsabaIcon name="note" />记一下</Button>
          <Button onClick={() => { refreshJobs(); setPage("jobs"); setNotice(""); }}><AsabaIcon name="delegate" />委托{jobs.some(active) && <i className="asaba-job-dot" aria-label="有委托进行中" />}</Button>
        </div>
        <div className="asaba-actions asaba-links">
          <Button variant="ghost" size="small" onClick={() => void openRecap()}>{recapBusy ? "回顾整理中" : "今日回顾"}</Button>
          <Button variant="ghost" size="small" onClick={() => void run(openNews)}>资讯</Button>
          {!listening && !dictationPaused && <Button variant="ghost" size="small" disabled={busy} onClick={() => void dictate()} title="Ctrl + Alt + Space"><AsabaIcon name="voice" />语音</Button>}
          <Button variant="ghost" size="small" onClick={() => { refreshObservation(); setPage("settings"); }}>设置</Button>
        </div>
        {status?.context.activeFocus ? <section className="asaba-focus-current">
          <small>正在投入</small><strong>{status.context.activeFocus.label}</strong><time>{focus.elapsed}</time>
          {focus.idle && <p>有一会儿没操作电脑了，这次投入结束了吗？</p>}
        </section> : focus.suggestion && <div className="asaba-focus-start">
          <p>你在 {focus.suggestion.replace(/\.exe$/i, "")} 持续工作了一会儿，要记下这次投入吗？</p>
          <Button size="small" onClick={() => setPage("focus")}>记下这次投入</Button>
          <Button size="small" variant="ghost" onClick={focus.dismiss}>暂时不用</Button>
        </div>}
      </>}
      {page === "focus" && status && <AsabaFocusPanel context={status.context} suggestedApplication={focus.suggestion} onChanged={() => { refresh(); setPage("home"); }} onError={setNotice} />}
      {page === "news" && <div className="asaba-news">
        {status?.context.brief ? <><small>{status.context.brief.date}</small><ol>{status.context.brief.news.map((item, index) => <li key={index}><Suspense fallback={<p>{item}</p>}><AiMarkdown>{item}</AiMarkdown></Suspense></li>)}</ol></> : <p>今天的早报还没有缓存，请在工作台首页刷新。</p>}
        <section><h3>关注的 AI 资讯</h3>
          {(status?.context.news ?? []).filter(item => item.matched).map((item, index) => <p key={index}>{item.title}</p>)}
          {!(status?.context.news ?? []).some(item => item.matched) && <p>暂无关注词命中的标题。</p>}
        </section>
        {status?.context.brief?.tip && <p className="asaba-news-tip">{status.context.brief.tip}</p>}
        <Button size="small" disabled={audio !== "off" && audio !== "error"} onClick={() => { setNotice(""); void speak(status ? companionReadout(status) : "暂无资讯。"); }}>朗读资讯</Button>
      </div>}
      {page === "note" && <form className="asaba-form" onSubmit={event => { event.preventDefault(); void run(save); }}>
        <div className="asaba-note-tools"><small>保存到笔记 · 待分类</small><Button size="small" variant="ghost" aria-expanded={noteOptions} onClick={() => setNoteOptions(!noteOptions)}>＋ 附加{draft.projectId ? " · 已关联" : ""}</Button></div>
        <textarea ref={draftText} aria-label="便签内容" rows={4} maxLength={4000} placeholder="刚刚发现了什么？" value={draft.text} onChange={e => setDraft({ ...draft, text: e.target.value })} />
        {noteOptions && <div className="asaba-note-extras">
        <SelectMenu label="关联项目" value={draft.projectId} onChange={projectId => setDraft({ ...draft, projectId })} options={[{ value: "", label: "不关联项目" }, ...(status?.context.projects ?? []).map(project => ({ value: project.id, label: project.title }))]} />
        <input aria-label="附上网页链接" placeholder="附上网页链接（可选）" maxLength={2048} value={draft.url} onChange={e => setDraft({ ...draft, url: e.target.value })} />
        <small>链接会附在笔记末尾，方便回到灵感来源，不会自动抓取网页。</small>
        {observation?.sourceApplication && <label className="asaba-check"><input type="checkbox" checked={includeApp} onChange={e => setIncludeApp(e.target.checked)} /> 附上 {observation.sourceApplication}</label>}
        {observation?.sourceShot && <label className="asaba-check"><input type="checkbox" checked={includeShot} onChange={e => setIncludeShot(e.target.checked)} /> 关联刚才的本地画面</label>}
        </div>}
        <div className="asaba-actions">
          <Button variant="primary" type="submit" disabled={!canSave || busy || listening}>保存笔记</Button>
          {!listening && !dictationPaused && <Button variant="ghost" disabled={busy} onClick={() => void dictate()}>听写</Button>}
        </div>
      </form>}
      {page === "saved" && savedNote && <div className="asaba-form">
        <p role="status">已保存到「笔记 · 待分类」。</p><strong>{savedNote.title || "链接笔记"}</strong>
        <Button onClick={() => void run(async () => { await companionApi.action({ kind: "open_note", id: savedNote.noteId, label: "查看笔记" }); })}>在工作台查看笔记</Button>
        <Button onClick={() => { setPage("note"); setNotice(""); }}>再记一条</Button>
        {savedNote.description && <details className="asaba-details"><summary>从这篇笔记创建委托</summary><p>确认说明、项目和执行目录后创建会话。</p><Button size="small" onClick={() => void run(() => prepare(savedNote))}>整理委托说明</Button></details>}
      </div>}
      {page === "recap" && <>
        <div className="asaba-recap-tools">
          <small>{recap ? `${recap.day} · ${clock(recap.generated_at)} 整理` : "按当天已记录的线索整理"}</small>
          {recapBusy ? <Button size="small" variant="ghost" onClick={() => void cancelRecap()}>取消整理</Button>
            : <Button size="small" variant="ghost" onClick={() => void openRecap(true)}>{recap ? "更新回顾" : "生成回顾"}</Button>}
        </div>
        {recapBusy && <p className="asaba-recap-hint" role="status">正在整理，可以继续记笔记或处理委托。</p>}
        {recap ? <>
        <div className="asaba-actions"><small>{recap.local_model ? "本机整理" : "根据已有线索生成的简版"}</small><Button size="small" disabled={audio !== "off" && audio !== "error"} onClick={() => { setNotice(""); void speak(recap.text); }}>朗读回顾</Button></div>
        <div className="asaba-markdown"><Suspense fallback={<p>{recap.text}</p>}><AiMarkdown>{recap.text}</AiMarkdown></Suspense></div>
        <details className="asaba-details"><summary>查看今天的时间线 · {recap.items.length} 条</summary>
          {recap.items.map((item, i) => <article key={i}>
            <small>{clock(item.at)}{item.end ? "–" + clock(item.end) : ""} · {kindLabel[item.kind] || item.kind}</small><p>{item.text}</p>
            {item.kind === "screen" && item.source && <AsabaShotPreview id={item.source} />}
            {item.kind === "codex" && <details><summary>查看会话摘录</summary><pre>{status?.records.find(record => record.id === item.source)?.text || "暂无摘录"}</pre></details>}
          </article>)}
        </details>
      </> : !recapBusy && <p>这次回顾暂未生成。</p>}
      </>}
      {page === "settings" && <AsabaSettings
        observation={observation} status={status} idleMotion={roam} smalltalk={smalltalk} focusSuggestions={focusSuggestions} busy={busy}
        onIdleMotion={value => { setRoam(value); localStorage.setItem(movementKey, value ? "on" : "off"); }}
        onSmalltalk={value => { setSmalltalk(value); localStorage.setItem("asaba.smalltalk", value ? "on" : "off"); }}
        onFocusSuggestions={value => { setFocusSuggestions(value); localStorage.setItem("asaba.focus-suggestions", value ? "on" : "off"); }}
        onObservation={(operation, executable) => void run(async () => setObservation(await companionApi.observation(operation, executable)))}
        onCodex={enabled => void run(async () => setStatus(await companionApi.enable(enabled)))}
        onReadCodex={() => void run(async () => setStatus(await companionApi.refresh()))}
        onPauseAll={() => void run(async () => {
          setStatus(await companionApi.pauseAll());
          setObservation(await companionApi.observation());
        })}
        onPreviewVoice={() => { setNotice(""); void speak("你好，我是浅羽。今天也陪你慢慢来。"); }}
        onHide={() => void run(() => companionApi.window(false, false))}
      />}
      {page === "delegate" && delegation && <AsabaDelegationForm
        key={delegation.requestId} initial={delegation} projects={status?.context.projects ?? []} busy={busy}
        onSubmit={request => void run(async () => {
          await companionApi.delegate(request);
          refreshJobs(); setPage("jobs");
        })}
      />}
      {page === "jobs" && <>
        <details className="asaba-details"><summary>从已有笔记创建委托</summary>
          {(status?.context.notes ?? []).map(note => <Button key={note.id} size="small" variant="ghost" onClick={() => void run(async () => { await companionApi.action({ kind: "prepare_note", id: note.id, label: "从笔记创建委托" }); })}>{note.title}</Button>)}
          {!(status?.context.notes ?? []).length && <p>还没有浅羽笔记，可以先记一条。</p>}
        </details>
        <Button variant="primary" onClick={() => { setPage("note"); setNotice("先保存一篇笔记，再从笔记创建委托。"); }}>记下待委托的内容</Button>
        <small>委托记录保留执行会话和测试结果。</small>
        {jobs.length ? jobs.map(job => <AsabaJobCard key={job.id} job={job} onCancel={active(job) && job.state !== "recovering" ? () => void run(async () => { await companionApi.jobAction(job.id, "cancel"); setNotice("已请求取消。"); }) : undefined} onContinue={!active(job) ? () => void run(() => prepare({
          ...job,
          previousJobId: job.sessionId ? job.id : undefined,
          description: ["interrupted", "cancelled", "failed"].includes(job.state) ? job.description : "",
        })) : undefined} />) : <p>还没有委托。写下一个 Bug 后，可以交给 Codex 排查。</p>}
        {jobs.some(active) && <small>{jobs.filter(active).map(job => asabaJobLabels[job.state]).join(" · ")}</small>}
      </>}
    </section>
    {(notice || listening || dictationPaused || audio !== "off") && <footer className="asaba-footer">
      {notice && <p role="status">{notice}</p>}
      {(listening || dictationPreview) && <div className="asaba-dictation-preview"><small>{listening ? dictationReady ? "正在听写 · 实时预览" : "正在加载本机听写…" : "本次识别"}</small><p aria-live="polite">{dictationPreview || "开口后，识别结果会显示在这里。"}</p></div>}
      {listening && <Button size="small" onClick={() => void pauseDictation().catch(error)}>停止并放入笔记</Button>}
      {dictationPaused && !listening && <Button size="small" onClick={() => void dictate()}>继续听写</Button>}
      {progress && <div className="asaba-speech-progress"><small>第 {progress.index + 1} / {progress.total} 句</small><p>{progress.text}</p></div>}
      {audio !== "off" && <div className="asaba-actions">
        {audio === "error" ? <Button size="small" onClick={() => { setNotice(""); void retrySpeech(); }}>从当前句继续</Button>
          : <Button size="small" onClick={() => void toggleSpeech()}>{audio === "paused" ? "继续朗读" : "暂停朗读"}</Button>}
        <Button size="small" variant="ghost" onClick={stopSpeech}>停止朗读</Button>
      </div>}
    </footer>}
    </aside>
  </main>;
}
