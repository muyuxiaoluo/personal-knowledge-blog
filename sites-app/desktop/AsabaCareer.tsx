import { useRef, useState, type FormEvent } from "react";
import { careerRecruitmentBatch, careerResearchTopic, careerUnknown, type CareerReport, type CareerReview, type CareerScope } from "../app/asaba-career";
import { needsResearchReview, researchQueries, type ResearchReport } from "../app/asaba-worker";
import { Button, SelectMenu } from "./DesktopControls";
import { openUrl } from "@tauri-apps/plugin-opener";

export function AsabaCareerScope({ request, projects, suggested, busy, onStart }: {
  request: string; projects: { id: string; title: string }[]; suggested: string | null; busy: boolean;
  onStart: (id: string, scope: CareerScope) => void;
}) {
  const [direction, setDirection] = useState(() => careerResearchTopic(request));
  const [region, setRegion] = useState("");
  const [batch, setBatch] = useState(() => careerRecruitmentBatch(request));
  const [projectId, setProjectId] = useState(suggested ?? "");
  const [includeBackground, setIncludeBackground] = useState(false);
  const [background, setBackground] = useState("");
  const [checkedTopic, setCheckedTopic] = useState("");
  const [queries, setQueries] = useState<string[]>([]);
  const identity = useRef<{ key: string; id: string } | null>(null);
  const topic = [direction.trim(), region.trim(), batch.trim(), "招聘岗位"].filter(Boolean).join(" ");
  const checked = topic === checkedTopic;
  const valid = direction.trim() && !needsResearchReview(topic);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || busy) return;
    if (!checked) {
      setCheckedTopic(topic);
      setQueries(researchQueries(topic));
      return;
    }
    const scope = { topic, queries: queries.map(query => query.trim()), projectId: projectId || null, background: includeBackground ? background.trim() : "" };
    if (scope.queries.some(query => !query || needsResearchReview(query))) return;
    const key = JSON.stringify(scope);
    if (identity.current?.key !== key) identity.current = { key, id: crypto.randomUUID() };
    onStart(identity.current.id, scope);
  }
  return <form className="asaba-form" onSubmit={submit}>
    <label className="asaba-field">岗位方向<input value={direction} maxLength={96} onChange={event => setDirection(event.target.value)} placeholder="例如 ROS2 或机器人系统软件" required /></label>
    <label className="asaba-field">地区（可选）<input value={region} maxLength={24} onChange={event => setRegion(event.target.value)} /></label>
    <label className="asaba-field">招聘批次（可选）<input value={batch} maxLength={24} onChange={event => setBatch(event.target.value)} placeholder="例如 2027 年校招" /></label>
    <SelectMenu label="路线归属" value={projectId} onChange={setProjectId} options={[{ value: "", label: "完成后可新建项目" }, ...projects.map(project => ({ value: project.id, label: project.title }))]} />
    <label><input type="checkbox" checked={includeBackground} onChange={event => setIncludeBackground(event.target.checked)} /> 提供个人背景给规划模型比较</label>
    {includeBackground && <label className="asaba-field">愿意提供给 DeepSeek 规划模型的背景<textarea value={background} maxLength={1500} onChange={event => setBackground(event.target.value)} placeholder="例如做过的项目、学过的技能或学历" /></label>}
    {!includeBackground && <small>学历、经历和能力记录中的缺口会列为待验证。</small>}
    {direction.trim() && !valid && <p role="status">请用可公开搜索的岗位关键词。个人背景可在上方单独填写。</p>}
    {checked && <fieldset className="asaba-form"><legend>将发送的公开搜索词</legend>{queries.map((query, index) => <input
      key={index} aria-label={`搜索词 ${index + 1}`} value={query} maxLength={128}
      onChange={event => setQueries(items => items.map((item, i) => i === index ? event.target.value : item))} required />)}</fieldset>}
    <Button type="submit" variant="primary" disabled={busy || !valid || (checked && queries.some(query => !query.trim() || needsResearchReview(query)))}>{checked ? "确认并开始后台规划" : "预览调研范围"}</Button>
  </form>;
}

export function CareerSources({ report }: { report: ResearchReport }) {
  const [error, setError] = useState("");
  return <details><summary>调研依据 · {report.sources.length} 个来源 · {report.positions.length} 个岗位</summary>
    <ul>{report.positions.map(position => <li key={position.sourceId}>[{position.sourceId}] {position.company} · {position.role} · {position.requirements.join("、")}</li>)}</ul>
    <ul>{report.sources.map(source => <li key={source.id}>[{source.id}] <Button size="small" variant="ghost" onClick={() => void openUrl(source.url).catch(cause => setError(String(cause)))}>{source.title || source.url}</Button> · {source.readAt ? "已读取正文" : "搜索摘要"}</li>)}</ul>
    {report.limitations.map((item, index) => <p key={index}>{item}</p>)}
    {error && <p role="status">{error}</p>}
  </details>;
}

export function CareerReviewDialog({ jobId, report, initialProjectId, initialSnapshot, projects, onSnapshot, onSave, onClose }: {
  jobId: string; report: CareerReport; initialProjectId: string | null; initialSnapshot: string | null;
  projects: { id: string; title: string; planningMode: string }[];
  onSnapshot: (projectId: string) => Promise<{ snapshot: string; current: string[] }>;
  onSave: (jobId: string, review: CareerReview) => Promise<void>;
  onClose: () => void;
}) {
  const route = report.route!;
  const [title, setTitle] = useState(route.title);
  const [outcome, setOutcome] = useState(route.outcome);
  const [stages, setStages] = useState(() => route.stages.map(stage => ({ ...stage, selected: true })));
  const [action, setAction] = useState(route.nextAction);
  const [useAction, setUseAction] = useState(false);
  const [projectId, setProjectId] = useState(projects.some(project => project.id === initialProjectId) ? initialProjectId ?? "" : "");
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [current, setCurrent] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialProjectId && !projects.some(project => project.id === initialProjectId) ? "原项目已不可用，请选择保存去向。" : "");
  const selected = projects.find(project => project.id === projectId);
  async function verify() {
    setBusy(true); setError("");
    try {
      const checked = await onSnapshot(projectId);
      setSnapshot(checked.snapshot);
      setCurrent(checked.current);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await onSave(jobId, { title, outcome, stages: stages.filter(stage => stage.selected)
        .map(({ title, done, sourceIds }) => ({ title, done, sourceIds })), action: useAction ? action : "", projectId: projectId || null, snapshot: projectId ? snapshot : null });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const setStage = (index: number, patch: Partial<(typeof stages)[number]>) =>
    setStages(items => items.map((item, i) => i === index ? { ...item, ...patch } : item));
  return <div className="focus-recovery-backdrop"><section className="focus-recovery-dialog career-review-dialog" role="dialog" aria-modal="true" aria-label="确认求职路线">
    <h2>确认求职路线</h2>
    <CareerSources report={report.research} />
    {route.gaps.some(item => item.evidence) && <p>报告中引用的背景会随项目积累一起保存。</p>}
    {route.gaps.map((item, index) => <article key={index}>
      <strong>{item.requirement} [{item.sourceIds.join(" · ")}]</strong>
      {item.evidence && <p>已提供的能力依据 · {item.evidence}</p>}
      {item.unknown && <p>待验证 · {careerUnknown(item.unknown)}</p>}
    </article>)}
    <form onSubmit={event => void save(event)}>
      <SelectMenu label="保存去向" value={projectId} onChange={value => { setProjectId(value); setSnapshot(null); setCurrent([]); setError(""); }}
        options={[{ value: "", label: "新建求职项目" }, ...projects.map(project => ({ value: project.id, label: project.title }))]} />
      {selected && <div>
        <Button type="button" size="small" disabled={busy} onClick={() => void verify()}>核对当前项目</Button>
        {current.map((text, index) => <p key={index}>{text}</p>)}
        {selected.planningMode === "direct" && <p>选中的路线内容保存到项目积累。</p>}
      </div>}
      <label>{selected ? "报告名称" : "新项目名称"}<input value={title} onChange={event => setTitle(event.target.value)} maxLength={100} required /></label>
      <label>期望结果<textarea value={outcome} onChange={event => setOutcome(event.target.value)} maxLength={320} required /></label>
      {stages.map((stage, index) => <fieldset key={index}>
        <legend><label><input type="checkbox" checked={stage.selected} onChange={event => setStage(index, { selected: event.target.checked })} /> 采用阶段 {index + 1} · [{stage.sourceIds.join(" · ")}]</label></legend>
        {stage.selected && <>
          <label>阶段名称<input value={stage.title} onChange={event => setStage(index, { title: event.target.value })} maxLength={100} required /></label>
          <label>完成标准<textarea value={stage.done} onChange={event => setStage(index, { done: event.target.value })} maxLength={320} required /></label>
        </>}
      </fieldset>)}
      {route.nextAction && <label className="career-review-check"><input type="checkbox" checked={useAction} onChange={event => setUseAction(event.target.checked)} /> 追加一条行动</label>}
      {useAction && <label>行动名称<input value={action} onChange={event => setAction(event.target.value)} maxLength={200} required /></label>}
      {error && <p role="status">{error}</p>}
      <footer><Button type="button" disabled={busy} onClick={onClose}>返回</Button><Button type="submit" variant="primary" disabled={busy || Boolean(projectId && !snapshot)}>确认保存</Button></footer>
    </form>
  </section></div>;
}
