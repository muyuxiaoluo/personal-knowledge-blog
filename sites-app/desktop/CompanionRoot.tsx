import { AsabaDocumentForm, AsabaResearchForm } from "./AsabaWorkerForms";
import { jobStatusLabel, researchIntent, researchProject, researchQueries, type DocumentInput } from "../app/asaba-worker";
import type { CareerScope } from "../app/asaba-career";
import { asabaCapabilities, isAsabaCapability, matchAsabaProject, routeAsabaRequest, type AsabaCapabilityId, type AsabaLocalProjectProgress } from "../app/asaba-capabilities";
import { AsabaCareerScope } from "./AsabaCareer";
import { formatAsabaEvidenceDate, maxAuthorizedProjectNotes, type AsabaPlanPreview, type AsabaPlanningResult, type AsabaProjectNote } from "../app/asaba-planning";
import { ProjectDecisionResult } from "./ProjectDecisionResult";
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
import { AsabaAttention } from "./AsabaAttention";
import type { AttentionCommand, AttentionView } from "../app/asaba-attention";
const AiMarkdown = lazy(async () => ({ default: (await import("./AiMarkdown")).AiMarkdown }));

type Page = "home" | "note" | "saved" | "recap" | "settings" | "delegate" | "jobs" | "news" | "focus" | "plan" | "research" | "document" | "attention" | "career";
type Draft = { id: string; text: string; url: string; projectId: string };

const blank = (): Draft => ({ id: crypto.randomUUID(), text: "", url: "", projectId: "" });
const clock = (value: string) => new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
const kindLabel: Record<string, string> = { app: "前台应用", screen: "画面线索", codex: "你的 Codex 会话", note: "随手记", worker: "浅羽代办" };
const active = (job: AsabaJob) => ["queued", "running", "recovering"].includes(job.state);
const initialStage: AsabaStage = { expanded: false, walking: false, direction: 1, mood: "idle", layout: { petX: 0, petY: 0, bubbleX: 0, bubbleY: 0, tailY: 80, bubbleLeft: true } };
const movementKey = "asaba.idle-motion";
const capabilityChoices = Object.keys(asabaCapabilities).filter(isAsabaCapability);

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
  const [attention, setAttention] = useState<AttentionView | null>(null);
  const [attentionJob, setAttentionJob] = useState<string | null>(null);
  const [requestText, setRequestText] = useState("");
  const [careerRequest, setCareerRequest] = useState("");
  const [manualRoute, setManualRoute] = useState(false);
  const [routeQuestion, setRouteQuestion] = useState("");
  const [routeReply, setRouteReply] = useState("");
  const [localProgress, setLocalProgress] = useState<{ projectId: string; data: AsabaLocalProjectProgress } | null>(null);
  const [progressTarget, setProgressTarget] = useState(false);
  const [recap, setRecap] = useState<AsabaRecap | null>(null);
  const [recapBusy, setRecapBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(blank);
  const [includeApp, setIncludeApp] = useState(false);
  const [includeShot, setIncludeShot] = useState(false);
  const [delegation, setDelegation] = useState<AsabaDelegation | null>(null);
  const [researchTopic, setResearchTopic] = useState("");
  const lastResearch = useRef<{ key: string; id: string } | null>(null);
  const [planText, setPlanText] = useState("");
  const [projectAnswer, setProjectAnswer] = useState<{ request: string; result: Exclude<AsabaPlanningResult, { kind: "plan" }> } | null>(null);
  const [planProject, setPlanProject] = useState<string | null>(null);
  const [planScope, setPlanScope] = useState<{ projectId: string; milestoneId: string | null; title: string } | null>(null);
  const [projectNotes, setProjectNotes] = useState<{ projectId: string; notes: AsabaProjectNote[] } | null>(null);
  const [authorizedNoteIds, setAuthorizedNoteIds] = useState<string[]>([]);
  const [plan, setPlan] = useState<{ id: string; request: string; draft: AsabaPlanPreview } | null>(null);
  const [withMilestone, setWithMilestone] = useState(false);
  const [repeatCompletedAction, setRepeatCompletedAction] = useState(false);
  const [planSaved, setPlanSaved] = useState<{ projectId?: string } | null>(null);
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
  const dictationTarget = useRef<"home" | "plan" | "note">("home");
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
      listen<AttentionView>("asaba-attention-changed", ({ payload }) => setAttention(payload)),
      listen<AsabaStage>("asaba-stage", ({ payload }) => setStage(payload)),
      listen("asaba-voice-shortcut", () => voiceAction.current()),
      listen<string>("asaba-tts-phase", ({ payload }) => setTtsPhase(payload)),
      listen<string>("companion-action-result", ({ payload }) => setNotice(payload)),
      listen<{ projectId: string; notes?: AsabaProjectNote[]; scope?: { projectId: string; milestoneId: string | null; title: string } }>("asaba-plan-project", ({ payload }) => {
        if (operation.current || hearing.current) { setNotice("浅羽正在处理，请稍后再次打开项目规划。"); return; }
        setPlanProject(payload.projectId);
        setPlanScope(payload.scope ?? null);
        setProjectNotes({ projectId: payload.projectId, notes: payload.notes ?? [] });
        setAuthorizedNoteIds([]);
        setPlanText("请根据这个项目的当前进展，建议一个下一步。");
        setProjectAnswer(null); setPlan(null); setPlanSaved(null); setNotice(""); setPage("plan");
      }),
      listen<DelegationSource>("asaba-prepare-note", ({payload}) => { void prepare(payload).catch(error); }),
      listen<{id: string; text?: string; ready?: boolean; warning?: string}>("asaba-dictation-text", ({payload}) => {
        if (payload.id !== dictationId.current) return;
        if (payload.text !== undefined) setDictationPreview(payload.text);
        if (payload.ready) setDictationReady(true);
        if (payload.warning) setNotice(payload.warning);
      }),
    ];
    void Promise.all(subscriptions).then(() => {
      void companionApi.attention({ kind: "get" }).then(setAttention).catch(() => {});
      return companionApi.stage();
    }).catch(error);
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
  async function openAttention() {
    setPage("attention");
    setNotice("");
    setAttention(await companionApi.attention({ kind: "get" }));
  }

  async function changeAttention(command: AttentionCommand) {
    setAttention(await companionApi.attention(command));
    if (command.kind === "link") setNotice("已关联收藏，可在项目里打开原条目。");
  }

  async function openAttentionItem(kind: "project" | "task" | "source" | "job", id: string, keys: string[]) {
    if (kind === "job") {
      const current = await companionApi.jobs();
      if (!current.some(job => job.id === id)) throw new Error("委托已发生变化，请刷新后核对。");
      setJobs(current);
      setAttentionJob(id);
      setPage("jobs");
    } else {
      await companionApi.openAttentionItem(kind, id);
    }
    await changeAttention({ kind: "read", keys });
  }
  async function startResearch(topic: string, background = "") {
    const key = JSON.stringify([topic, background, planProject]);
    if (lastResearch.current?.key !== key) lastResearch.current = { key, id: crypto.randomUUID() };
    const defaults = await companionApi.researchDefaults(topic, planProject);
    await companionApi.research({ requestId: lastResearch.current.id, projectId: defaults.projectId,
      input: { topic, queries: researchQueries(topic), model: defaults.model, ...(background ? { background } : {}) } });
    refreshJobs();
    setAttentionJob(null);
    setPage("jobs");
    setNotice("调研已交给浅羽，可收起气泡。");
  }

  function startDocument(requestId: string, input: DocumentInput, projectId: string | null) {
    void run(async () => {
      await companionApi.checkDocument({ requestId, input, projectId });
      refreshJobs(); setAttentionJob(null); setPage("jobs"); setNotice("论文格式检查已开始。");
    });
  }

  async function askForPlan(request: string, projectId: string | null, usePanelScope = true) {
    const approved = usePanelScope && projectId && projectId === projectNotes?.projectId ? authorizedNoteIds : [];
    setAuthorizedNoteIds([]);
    const result = await companionApi.plan(request, projectId, approved,
      usePanelScope && planScope && planScope.projectId === projectId ? planScope.milestoneId : undefined);
    const draft = result.kind === "plan" ? result.draft : result.kind === "progress" ? result.actionDraft : null;
    setProjectAnswer(result.kind === "plan" ? null : { request, result });
    setPlan(draft ? { id: crypto.randomUUID(), request, draft } : null);
    setPlanSaved(null);
    setWithMilestone(Boolean(draft?.milestone));
    setRepeatCompletedAction(false);
    if (result.kind === "progress") setPlanProject(result.projectId);
  }

  async function openCapability(id: AsabaCapabilityId, request: string, args: { project?: string; topic?: string } = {}, projectId?: string) {
    setPlanScope(null);
    setProjectNotes(null);
    setAuthorizedNoteIds([]);
    setManualRoute(false);
    setRouteQuestion("");
    setRouteReply("");
    setProgressTarget(false);
    setLocalProgress(null);
    const projects = status?.context.projects ?? [];
    const named = projects.filter(project => !project.isDraft && request.includes(project.title));
    const target = projectId ?? matchAsabaProject(projects, args.project ?? "")?.id ?? (named.length === 1 ? named[0].id : "");
    switch (id) {
      case "note":
        setDraft({ ...blank(), text: request });
        setPage("note");
        return;
      case "career":
        setCareerRequest(request);
        setPage("career");
        return;
      case "document":
        setPage("document");
        return;
      case "delegate":
        await prepare({ noteId: "project-request:" + crypto.randomUUID(), projectId: target,
          title: request.split("\n")[0].slice(0, 100), description: request, repository: "" });
        return;
      case "research":
        setResearchTopic(args.topic ?? researchIntent(request)?.topic ?? "");
        setPlanProject(null);
        setPage("research");
        return;
      case "progress":
        if (!target) { setProgressTarget(true); return; }
        setLocalProgress({ projectId: target, data: await companionApi.projectProgress(target) });
        return;
      case "recap":
        await openRecap();
        return;
      case "plan":
        setPlanProject(target || null);
        setPlanText(request);
        setProjectAnswer(null); setPlan(null); setPlanSaved(null);
        setPage("plan");
    }
  }

  function submitRequest() {
    const request = requestText.trim();
    if (!request || (routeQuestion && !routeReply.trim())) return;
    const combined = [request, routeQuestion && routeReply.trim()].filter(Boolean).join("\n\n");
    void run(async () => {
      setManualRoute(false); setProgressTarget(false); setLocalProgress(null);
      const result = await routeAsabaRequest(combined, companionApi.route);
      if (result.kind === "ready") {
        await openCapability(result.call.id, result.call.id === "note" ? request : combined, result.call.args);
      } else if (result.kind === "clarify" && !routeQuestion) {
        setRouteQuestion(result.question);
      } else {
        setRouteQuestion(""); setRouteReply(""); setManualRoute(true);
        setNotice(result.kind === "manual" && result.reason === "unavailable"
          ? "本机模型暂时不可用，可以直接选择功能。" : "浅羽还无法确定要做什么，可以直接选择功能。");
      }
    });
  }

  function startCareer(id: string, scope: CareerScope) {
    void run(async () => {
      await companionApi.startCareer(id, scope);
      setCareerRequest("");
      setAttentionJob(id); refreshJobs(); setPage("jobs");
      setNotice("已开始后台求职规划，可以收起气泡。");
    });
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
  async function dictate(target: "home" | "plan" | "note" = "home") {
    if (hearing.current || operation.current) return;
    hearing.current = true;
    setListening(true); setNotice(""); setDictationPreview(""); setDictationReady(false);
    setPage(target);
    dictationTarget.current = target;
    try {
      stopSpeech();
      setDictationPaused(false);
      dictationId.current = crypto.randomUUID();
      const text = (await companionApi.dictation("listen", dictationId.current)).trim();
      setDictationPreview("");
      if (!text) { setNotice("没听清，可以再说一次。"); return; }
      if (target === "plan") {
        setPlanText(current => [current, text].filter(Boolean).join("\n").slice(0, 4000));
      } else if (target === "note") {
        setDraft(current => ({ ...current, text: [current.text, text].filter(Boolean).join("\n").slice(0, 4000) }));
      } else {
        setRequestText(current => [current, text].filter(Boolean).join("\n").slice(0, 4000));
        setManualRoute(false); setRouteQuestion(""); setRouteReply(""); setProgressTarget(false); setLocalProgress(null);
        setProgressTarget(false);
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
  const pages: Record<Page, string> = { home: "浅羽", note: "随手记", saved: "笔记已保存", recap: "今日回顾", settings: "浅羽设置", delegate: "委托说明", jobs: "委托", news: "每日早报", focus: "开始投入", plan: "帮我规划", research: "后台调研", document: "检查论文格式", attention: "待关注", career: "求职调研与路线" };
  const unreadAttention = attention?.groups.filter(group => group.entries.some(entry => entry.unread)).length ?? 0;
  const showAttentionDot = Boolean(attention?.showDot && unreadAttention && !expanded && status && !status.context.activeFocus);
  function closeBubble() {
    pauseSpeech();
    if (!(page === "note" && canSave) && page !== "delegate" && page !== "focus" && page !== "plan" && page !== "research" && page !== "document" && page !== "career" && !busy && !listening) {
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
    <Button className="asaba-pet-button" variant="ghost" aria-label={expanded ? "收起浅羽气泡" : showAttentionDot ? "打开浅羽气泡，有未读待关注事项" : "打开浅羽气泡"} aria-expanded={expanded}
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
      {showAttentionDot && <span className="asaba-attention-dot" aria-hidden="true" />}
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
      {page !== "home" && <Button variant="ghost" size="small" disabled={page === "plan" && (busy || listening)} onClick={() => { setPage("home"); setNotice(""); }}>返回</Button>}
      <Button variant="ghost" size="small" iconOnly aria-label="收起气泡" onClick={closeBubble}>×</Button>
    </header>
    <section className="asaba-body">
      {page === "home" && <>
        <form className="asaba-form" onSubmit={event => { event.preventDefault(); submitRequest(); }}>
          <label className="asaba-field">想让浅羽帮你做什么<textarea value={requestText} maxLength={4000} rows={2} disabled={busy}
            onChange={event => { setRequestText(event.target.value); setManualRoute(false); setRouteQuestion(""); setRouteReply(""); setProgressTarget(false); setLocalProgress(null); }}
            placeholder="例如，帮我准备明年的机器人岗位求职" /></label>
          {routeQuestion && <label className="asaba-field">{routeQuestion}<input value={routeReply} maxLength={500} disabled={busy} onChange={event => setRouteReply(event.target.value)} /></label>}
          <div className="asaba-actions">
            <Button variant="primary" size="small" type="submit" disabled={busy || listening || !requestText.trim() || Boolean(routeQuestion && !routeReply.trim())}>{busy ? "处理中…" : "继续"}</Button>
            {requestText.trim() && <Button variant="ghost" size="small" type="button" disabled={busy || listening} onClick={() => { setManualRoute(!manualRoute); setRouteQuestion(""); setRouteReply(""); }}>选择功能</Button>}
          </div>
          {manualRoute && <div className="asaba-actions">{capabilityChoices.map(id =>
            <Button key={id} type="button" size="small" disabled={busy || listening} onClick={() => void run(() => openCapability(id, requestText.trim()))}>{asabaCapabilities[id].label}</Button>)}</div>}
          {progressTarget && <SelectMenu label="选择要查询的项目" disabled={busy} value="" onChange={value => { if (value) void run(() => openCapability("progress", requestText.trim(), {}, value)); }}
            options={[{ value: "", label: "请选择" }, ...(status?.context.projects ?? []).filter(project => !project.isDraft).map(project => ({ value: project.id, label: project.title }))]} />}
        </form>
        {localProgress && <section className="asaba-planning-preview" aria-label="本机项目进度">
          <strong>{localProgress.data.title} · {{ active: "正在推进", paused: "已暂停", completed: "已完成" }[localProgress.data.status]}</strong>
          {localProgress.data.outcome && <p>{localProgress.data.outcome}</p>}
          <p>{localProgress.data.recent ? [localProgress.data.recent.title, formatAsabaEvidenceDate(localProgress.data.recent.date), localProgress.data.recent.text].join(" · ") : "暂无进展记录。"}</p>
          {localProgress.data.next.map(value => <p key={value}>可继续 · {value}</p>)}
          {localProgress.data.waiting.map((value, index) => <p key={index}>等待中 · {value}</p>)}
          <Button size="small" onClick={() => void run(() => companionApi.openPlanProject(localProgress.projectId))}>打开项目</Button>
        </section>}
        <div className="asaba-home-actions">
          <Button className="asaba-primary" variant="primary" disabled={busy} onClick={() => status?.context.activeFocus ? void run(endFocus) : setPage("focus")}><AsabaIcon name="focus" />{status?.context.activeFocus ? "结束投入" : "开始投入"}</Button>
          <Button onClick={() => { setPage("plan"); setNotice(""); }}>帮我规划</Button>
          <Button onClick={() => { setPage("note"); setNotice(""); }}><AsabaIcon name="note" />记一下</Button>
          <Button onClick={() => { refreshJobs(); setAttentionJob(null); setPage("jobs"); setNotice(""); }}><AsabaIcon name="delegate" />委托{jobs.some(active) && <i className="asaba-job-dot" aria-label="有委托进行中" />}</Button>
        </div>
        <div className="asaba-actions asaba-links">
          <Button variant="ghost" size="small" disabled={busy} onClick={() => void run(openAttention)}>待关注{unreadAttention > 0 && ` · ${unreadAttention} 未读`}</Button>
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
      {page === "plan" && <div className="asaba-planning">
        {planProject && <div className="asaba-actions"><small>项目 · {status?.context.projects?.find(item => item.id === planProject)?.title || "当前项目"}{planScope && " · " + planScope.title}</small><Button variant="ghost" size="small" disabled={busy} onClick={() => { setPlanProject(null); setPlanScope(null); setProjectNotes(null); setAuthorizedNoteIds([]); setProjectAnswer(null); setPlan(null); setPlanSaved(null); }}>清除关联</Button></div>}
        <Button size="small" variant="ghost" disabled={busy} onClick={() => { const intent = researchIntent(planText); setResearchTopic(intent?.topic || ""); setPage("research"); }}>设置调研范围</Button>
        <label><span>你想实现什么？</span><textarea rows={3} maxLength={4000} value={planText} disabled={busy} onChange={event => setPlanText(event.target.value)} placeholder="例如，科研项目做到哪了？" /></label>
        <small>{planProject ? "分析时会将问题和所选项目的相关记录发送给 DeepSeek。" : "分析时会将问题和用于匹配项目的简要信息发送给 DeepSeek。"}</small>
        {projectNotes?.projectId === planProject && projectNotes.notes.length > 0 && <details className="asaba-details">
          <summary>授权本次调查{authorizedNoteIds.length > 0 && ` · ${authorizedNoteIds.length} 条`}</summary>
          <p>如果已有记录不足，浅羽会把勾选笔记的正文节选发给 DeepSeek 核对。最多选 {maxAuthorizedProjectNotes} 条。</p>
          {projectNotes.notes.map((note) => <label className="asaba-planning-option" key={note.id}>
            <input type="checkbox" checked={authorizedNoteIds.includes(note.id)} disabled={busy || (!authorizedNoteIds.includes(note.id) && authorizedNoteIds.length >= maxAuthorizedProjectNotes)}
              onChange={(event) => setAuthorizedNoteIds((current) => event.target.checked ? [...current, note.id] : current.filter((id) => id !== note.id))} />{note.title}
          </label>)}
        </details>}
        <div className="asaba-actions">
          <Button variant="primary" size="small" disabled={busy || listening || !planText.trim()} onClick={() => void run(async () => {
            const request = planText.trim();
            await askForPlan(request, planProject);
          })}>{busy && !plan ? "正在整理…" : plan || projectAnswer ? "重新分析" : "用 DeepSeek 分析"}</Button>
          <Button variant="ghost" size="small" disabled={busy || listening} onClick={() => void dictate("plan")}>听写</Button>
        </div>
        {busy && <small role="status">浅羽正在处理…</small>}
        {projectAnswer?.result.kind === "choose_project" && <div className="asaba-planning-preview">
          <strong>{projectAnswer.result.projects.length ? "请选择要查看的项目" : "暂时没有可查看的项目"}</strong>
          {projectAnswer.result.projects.map(item => <Button key={item.id} size="small" title={item.outcome} disabled={busy || listening || projectAnswer.request !== planText.trim()} onClick={() => void run(() => askForPlan(projectAnswer.request, item.id))}>{item.title}</Button>)}
        </div>}
        {projectAnswer?.result.kind === "clarify" && <p role="status">{projectAnswer.result.question}</p>}
        {projectAnswer?.result.kind === "progress" && <ProjectDecisionResult result={projectAnswer.result} disabled={busy || projectAnswer.request !== planText.trim()}
          onContinue={(id) => void run(async () => { await companionApi.openAttentionItem("task", id); })}
          onDelegate={() => void run(async () => { if (projectAnswer.result.kind === "progress") await companionApi.openProjectDelegation(projectAnswer.result); })}
          onAdjust={() => void run(async () => {
          const { result, request } = projectAnswer;
          if (result.kind !== "progress") return;
          await companionApi.openAdjustment({ projectId: result.projectId, request, suggestion: result.answer.nextAction, expectedUpdatedAt: result.expectedUpdatedAt });
          await closeBubble();
        })} />}
        {projectAnswer?.result.kind === "progress" && !plan && <Button size="small" disabled={busy} onClick={() => void run(async () => {
          if (projectAnswer.result.kind === "progress") await companionApi.openPlanProject(projectAnswer.result.projectId);
        })}>打开项目</Button>}
        {plan && <section className="asaba-planning-preview">
          <strong>{{ new_project: "建议建立项目", existing_project: "建议加入已有项目", action: "建议保存为独立行动", note: "建议先记下来" }[plan.draft.kind]}{plan.draft.projectTitle && " · " + plan.draft.projectTitle}</strong>
          {!projectAnswer && <p>{plan.draft.reason}</p>}
          {!projectAnswer && plan.draft.questions.length > 0 && <div><small>待确认</small><ul>{plan.draft.questions.map(question => <li key={question}>{question}</li>)}</ul></div>}
          {plan.draft.kind === "new_project" && <>
            <label><span>项目名称</span><input value={plan.draft.title} maxLength={200} disabled={busy || Boolean(planSaved)} onChange={event => setPlan({ ...plan, draft: { ...plan.draft, title: event.target.value } })} /></label>
            <label><span>期望结果</span><textarea rows={2} value={plan.draft.outcome} maxLength={2000} disabled={busy || Boolean(planSaved)} onChange={event => setPlan({ ...plan, draft: { ...plan.draft, outcome: event.target.value } })} /></label>
          </>}
          {plan.draft.kind !== "note" && <label><span>{plan.draft.kind === "new_project" ? "第一步 · 可选" : "行动名称"}</span><input value={plan.draft.action} maxLength={200} disabled={busy || Boolean(planSaved)} onChange={event => setPlan({ ...plan, draft: { ...plan.draft, action: event.target.value } })} /></label>}
          {plan.draft.expectedUpdatedAt !== undefined && <label><span>完成条件</span><textarea value={plan.draft.completionCondition ?? ""} maxLength={500} disabled={busy || Boolean(planSaved)} onChange={event => setPlan({ ...plan, draft: { ...plan.draft, completionCondition: event.target.value } })} /></label>}
          {plan.draft.previousCompletion && <label className="asaba-planning-option"><input type="checkbox" checked={repeatCompletedAction} disabled={busy || Boolean(planSaved)} onChange={event => setRepeatCompletedAction(event.target.checked)} />「{plan.draft.previousCompletion.title}」已有完成记录。确认这是一次新的执行。</label>}
          {plan.draft.milestone && <label className="asaba-planning-option"><input type="checkbox" checked={withMilestone} disabled={busy || Boolean(planSaved)} onChange={event => setWithMilestone(event.target.checked)} />关联当前节点 · {plan.draft.milestone.title}</label>}
          {plan.draft.kind === "note" && <p>{plan.request}</p>}
          <div className="asaba-actions">
            {!planSaved && <Button variant="primary" size="small" disabled={busy || plan.request !== planText.trim() || (plan.draft.kind === "new_project" && (!plan.draft.title.trim() || !plan.draft.outcome.trim())) || (["action", "existing_project"].includes(plan.draft.kind) && !plan.draft.action.trim()) || (plan.draft.expectedUpdatedAt !== undefined && !plan.draft.completionCondition?.trim()) || Boolean(plan.draft.previousCompletion && !repeatCompletedAction)} onClick={() => void run(async () => {
              setPlanSaved(await companionApi.savePlan({ ...plan, attachMilestone: withMilestone, repeatCompletedAction })); setNotice("已保存。");
            })}>{({ new_project: "创建项目", existing_project: "加入行动", action: "保存行动", note: "保存原话到笔记" })[plan.draft.kind]}</Button>}
            {(planSaved?.projectId || plan.draft.projectId) && <Button size="small" disabled={busy} onClick={() => void run(async () => {
              await companionApi.openPlanProject((planSaved?.projectId || plan.draft.projectId)!);
            })}>打开项目</Button>}
            {planSaved && <Button variant="ghost" size="small" onClick={() => { setProjectAnswer(null); setPlan(null); setPlanSaved(null); setPlanText(""); setNotice(""); }}>继续规划</Button>}
          </div>
        </section>}
      </div>}
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
          {!listening && !dictationPaused && <Button variant="ghost" disabled={busy} onClick={() => void dictate("note")}>听写</Button>}
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
      {page === "attention" && (attention ? <AsabaAttention groups={attention.groups} busy={busy}
        onCommand={command => void run(() => changeAttention(command))}
        onOpen={(kind, id, keys) => void run(() => openAttentionItem(kind, id, keys))}
      /> : <p>{busy ? "正在读取待关注事项…" : "暂时无法读取待关注事项。"}</p>)}
      {page === "settings" && <AsabaSettings
        observation={observation} status={status} idleMotion={roam} smalltalk={smalltalk} focusSuggestions={focusSuggestions} busy={busy}
        attentionDot={attention?.showDot ?? true}
        onAttentionDot={enabled => void run(() => changeAttention({ kind: "showDot", enabled }))}
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
          refreshJobs(); setAttentionJob(null); setPage("jobs");
        })}
      />}
      {page === "research" && <AsabaResearchForm initialTopic={researchTopic} busy={busy} onStart={(topic, background) => void run(() => startResearch(topic, background))} onCancel={() => setPage("plan")} />}
      {careerRequest && <div hidden={page !== "career"}><AsabaCareerScope key={careerRequest} request={careerRequest} busy={busy} onStart={startCareer}
        suggested={researchProject(careerRequest, null, (status?.context.projects ?? []).filter(project => project.status === "active"))}
        projects={(status?.context.projects ?? []).filter(project => !project.isDraft && project.status === "active")} /></div>}
      {page === "document" && <AsabaDocumentForm busy={busy} projects={status?.context.projects?.filter(project => !project.isDraft) ?? []} onStart={startDocument} onCancel={() => setPage("jobs")} onError={setNotice} />}
      {page === "jobs" && <>
        {attentionJob && <Button size="small" onClick={() => setAttentionJob(null)}>所有委托</Button>}
        <Button size="small" onClick={() => setPage("document")}>检查论文格式</Button>
        <details className="asaba-details"><summary>从已有笔记创建委托</summary>
          {(status?.context.notes ?? []).map(note => <Button key={note.id} size="small" variant="ghost" onClick={() => void run(async () => { await companionApi.action({ kind: "prepare_note", id: note.id, label: "从笔记创建委托" }); })}>{note.title}</Button>)}
          {!(status?.context.notes ?? []).length && <p>还没有浅羽笔记，可以先记一条。</p>}
        </details>
        <Button variant="primary" onClick={() => { setPage("note"); setNotice("先保存一篇笔记，再从笔记创建委托。"); }}>记下待委托的内容</Button>
        <small>可在这里查看调研与论文检查成果，也可继续处理代码委托。</small>
        {jobs.length ? jobs.filter(job => !attentionJob || job.id === attentionJob).map(job => <AsabaJobCard key={job.id} job={job} projects={status?.context.projects?.filter(project => !project.isDraft) ?? []} onArchive={command => companionApi.archiveWorker(command)} onCancel={active(job) && job.state !== "recovering" ? () => void run(async () => { await companionApi.jobAction(job.id, "cancel"); setNotice("已请求取消。"); }) : undefined} onContinue={job.agent === "codex" && !active(job) ? () => void run(() => prepare({
          ...job,
          agent: "codex",
          previousJobId: job.sessionId ? job.id : undefined,
          description: ["interrupted", "cancelled", "failed"].includes(job.state) ? job.description : "",
        })) : undefined} />) : <p>还没有委托。可以检查一份论文，或在「帮我规划」里提出公开调研。</p>}
        {jobs.some(active) && <small>{jobs.filter(active).map(job => jobStatusLabel(job) ?? asabaJobLabels[job.state]).join(" · ")}</small>}
      </>}
    </section>
    {(notice || listening || dictationPaused || audio !== "off") && <footer className="asaba-footer">
      {notice && <p role="status">{notice}</p>}
      {(listening || dictationPreview) && <div className="asaba-dictation-preview"><small>{listening ? dictationReady ? "正在听写 · 实时预览" : "正在加载本机听写…" : "本次识别"}</small><p aria-live="polite">{dictationPreview || "开口后，识别结果会显示在这里。"}</p></div>}
      {listening && <Button size="small" onClick={() => void pauseDictation().catch(error)}>停止并填入文字</Button>}
      {dictationPaused && !listening && <Button size="small" onClick={() => void dictate(dictationTarget.current)}>继续听写</Button>}
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
