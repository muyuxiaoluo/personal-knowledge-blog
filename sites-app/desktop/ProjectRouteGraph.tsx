import { useEffect, useRef, useState } from "react";
import type { Milestone, ProjectTask } from "../app/project-types";
import { routeDescendants, routeLayers, routeParents } from "../app/project-route";
import { Button, DateField } from "./DesktopControls";

const colors = ["#7182c4", "#509a86", "#b083b8", "#bd9358"];
function colorFor(id: string) { return colors[[...id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % colors.length]; }

type Props = {
  projectId: string; milestones: Milestone[]; tasks: ProjectTask[]; saving: boolean;
  onSave: (node: Milestone) => Promise<boolean>;
  onComplete: (node: Milestone) => void;
  onRemove: (node: Milestone) => void;
  onFocus: (node: Milestone) => void;
};

export function ProjectRouteGraph({ projectId, milestones, tasks, saving, onSave, onComplete, onRemove, onFocus }: Props) {
  const nodes = milestones.filter((node) => node.status !== "superseded");
  const parents = routeParents(nodes);
  const layers = routeLayers(nodes);
  const [draft, setDraft] = useState<Milestone | null>(null);
  const [error, setError] = useState("");
  const board = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [manualZoom, setManualZoom] = useState<number | null>(null);
  const [fitMode, setFitMode] = useState<"width" | "all">("width");
  const [fitZoom, setFitZoom] = useState(1);
  const [fitAllZoom, setFitAllZoom] = useState(1);
  const [boardSize, setBoardSize] = useState({ width: 1, height: 1 });
  const [edges, setEdges] = useState<Array<{ id: string; path: string; color: string; planned: boolean }>>([]);
  const active = nodes.filter((node) => node.status === "current");
  const selected = nodes.find((node) => node.id === selectedId) ?? active[0] ?? nodes[0];
  const zoom = manualZoom ?? (fitMode === "all" ? fitAllZoom : fitZoom);
  const maxLanes = Math.max(1, ...layers.map((row) => row.length));
  const descendants = draft?.id ? routeDescendants(nodes, draft.id) : new Set<string>();
  const selectedParents = draft?.predecessorIds ?? [];

  useEffect(() => {
    const host = board.current;
    if (!host) return;
    const measure = () => {
      // Measure in board coordinates so zooming cannot move the connection endpoints.
      const cards = new Map([...host.querySelectorAll<HTMLElement>("[data-route-node]")].map((el) => {
        const layer = el.parentElement!;
        return [el.dataset.routeNode!, { x: layer.offsetLeft + el.offsetLeft, y: layer.offsetTop + el.offsetTop, width: el.offsetWidth, height: el.offsetHeight }];
      }));
      const links: typeof edges = [];
      const visualParents = new Map(parents);
      if (draft?.id) visualParents.set(draft.id, draft.predecessorIds ?? []);
      for (const node of nodes) for (const id of visualParents.get(node.id) ?? []) {
        const from = cards.get(id), to = cards.get(node.id);
        if (!from || !to) continue;
        const x1 = from.x + from.width / 2, y1 = from.y + from.height;
        const x2 = to.x + to.width / 2, y2 = to.y;
        const mid = (y1 + y2) / 2;
        links.push({ id: `${id}:${node.id}`, path: `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`, color: colorFor((visualParents.get(node.id)?.length ?? 0) > 1 ? id : node.id), planned: node.status === "planned" });
      }
      setEdges(links);
      setBoardSize({ width: host.offsetWidth, height: host.offsetHeight });
      if (viewport.current) {
        const widthZoom = Math.min(1, Math.max(0.01, (viewport.current.clientWidth - 34) / host.offsetWidth));
        setFitZoom(widthZoom);
        setFitAllZoom(Math.min(widthZoom, Math.max(0.01, (viewport.current.clientHeight - 34) / host.offsetHeight)));
      }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    if (viewport.current) observer.observe(viewport.current);
    host.querySelectorAll("[data-route-node]").forEach((el) => observer.observe(el));
    measure();
    return () => observer.disconnect();
  }, [milestones, draft?.id, draft?.predecessorIds]);

  useEffect(() => {
    if (!expanded) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    section.current?.querySelector<HTMLButtonElement>("[data-route-expand]")?.focus();
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); setExpanded(false); }
      if (event.key === "Tab") {
        const controls = [...section.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, [tabindex="0"]')];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("keydown", handleKey); previousFocus?.focus(); };
  }, [expanded]);

  function create(predecessorIds: string[]) {
    const now = new Date().toISOString();
    setError("");
    setDraft({ id: "", projectId, title: "", definitionOfDone: "", predecessorIds, status: "planned", dueDate: "", sortOrder: Math.max(0, ...nodes.map((node) => node.sortOrder)) + 10, createdAt: now, updatedAt: now });
  }
  function edit(node: Milestone) { setError(""); setDraft({ ...node, predecessorIds: parents.get(node.id) ?? [] }); }
  function togglePredecessor(node: Milestone) {
    if (!draft || node.id === draft.id) return;
    if (descendants.has(node.id)) {
      setError(`“${node.title}”位于当前任务之后，不能反过来设为前置任务。`);
      return;
    }
    const selected = draft.predecessorIds ?? [];
    setError("");
    setDraft({
      ...draft,
      predecessorIds: selected.includes(node.id)
        ? selected.filter((id) => id !== node.id)
        : [...selected, node.id],
    });
  }
  const waiting = (node: Milestone) => (parents.get(node.id) ?? node.predecessorIds ?? []).filter((id) => nodes.find((item) => item.id === id)?.status !== "completed");
  const leaves = nodes.filter((node) => ![...parents.values()].some((ids) => ids.includes(node.id)));

  const selectedTasks = tasks.filter((task) => task.milestoneId === selected?.id && task.status !== "cancelled");
  const selectedBlockers = selected ? waiting(selected) : [];
  const statusLabel = (node: Milestone) => node.status === "completed" ? "✓ 已完成" : node.status === "current" ? "● 正在推进" : waiting(node).length ? "◷ 等待前置任务" : "○ 可以开展";

  return <section ref={section} className={`project-stage-overview route-graph-page${expanded ? " is-expanded" : ""}`} role={expanded ? "dialog" : undefined} aria-modal={expanded || undefined} aria-label="项目路线">
    <header><div><h2>项目路线</h2><p>{draft ? "点击图中的任务，选择或取消前置连接。" : "点击节点查看详情，随时操作当前任务。"}</p></div><div className="route-graph-toolbar"><Button size="small" variant="secondary" disabled={Boolean(draft)} onClick={() => create([])}>＋ 添加任务</Button><Button size="small" variant="secondary" disabled={Boolean(draft) || nodes.length < 2} onClick={() => create(leaves.map((node) => node.id))}>⑂ 添加汇合节点</Button><Button data-route-expand size="small" variant="secondary" aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "退出专注" : "专注查看"}</Button></div></header>
    <div className="route-graph-summary"><strong>{active.length ? `${active.length} 项正在推进` : "尚未开展任务"}</strong><span>{nodes.filter((node) => node.status === "completed").length} 项已完成</span><span>实线：已开展 · 虚线：待开展</span></div>
    <div className="route-workspace">
    <div className="route-canvas-pane">
      <div className="route-view-controls" aria-label="路线视图控制"><Button size="small" variant={manualZoom === null && fitMode === "width" ? "primary" : "secondary"} onClick={() => { setFitMode("width"); setManualZoom(null); }}>适合宽度</Button><Button size="small" variant={manualZoom === null && fitMode === "all" ? "primary" : "secondary"} onClick={() => { setFitMode("all"); setManualZoom(null); }}>查看全图</Button><Button size="small" variant="ghost" aria-label="缩小路线" onClick={() => setManualZoom(Math.max(0.01, zoom - 0.15))}>−</Button><span>{Math.round(zoom * 100)}%</span><Button size="small" variant="ghost" aria-label="放大路线" onClick={() => setManualZoom(Math.min(1.5, zoom + 0.15))}>＋</Button><Button size="small" variant="ghost" onClick={() => setManualZoom(1)}>原始大小</Button></div>
      <div ref={viewport} className={`route-graph-scroll${draft ? " is-connecting" : ""}`} tabIndex={0} aria-label="路线画布，可横向和纵向滚动"><div className="route-graph-scaled" style={{ width: boardSize.width * zoom, height: boardSize.height * zoom }}><div ref={board} className="route-graph-board" style={{ width: maxLanes * 240 + (maxLanes - 1) * 24 + 32, transform: `scale(${zoom})` }}>
        <svg className="route-graph-edges" aria-hidden="true">{edges.map((edge) => <path key={edge.id} d={edge.path} stroke={edge.color} strokeDasharray={edge.planned ? "6 5" : undefined} />)}</svg>
        {layers.map((row, index) => <div className="route-graph-layer" key={index}>{row.map((node) => {
          const nodeTasks = tasks.filter((task) => task.milestoneId === node.id && task.status !== "cancelled");
          const connectionSelected = selectedParents.includes(node.id);
          const connectionInvalid = Boolean(draft?.id && descendants.has(node.id));
          return <article key={node.id} data-route-node={node.id} className={`route-task-card ${node.status}${!draft && selected?.id === node.id ? " is-selected" : ""}${connectionSelected ? " connection-selected" : ""}${connectionInvalid ? " connection-invalid" : ""}${draft?.id === node.id ? " connection-self" : ""}`} style={{ borderTopColor: colorFor(node.id) }}>
            <header><span>{statusLabel(node)}</span>{(parents.get(node.id)?.length ?? 0) > 1 && <small>汇合</small>}</header>
            <h3>{node.title}</h3>
            <div className="route-task-meta"><span>{nodeTasks.filter((task) => task.status === "done").length}/{nodeTasks.length} 行动完成</span>{node.dueDate && <time>{node.dueDate}</time>}</div>
            {!draft && <button type="button" className="route-node-select" aria-label={`查看任务：${node.title}`} aria-pressed={selected?.id === node.id} onClick={() => setSelectedId(node.id)} />}
            {draft && node.id !== draft.id && <button type="button" className="route-connect-target" aria-label={`前置任务：${node.title}`} aria-pressed={connectionSelected} disabled={connectionInvalid} onClick={() => togglePredecessor(node)}><span>{connectionInvalid ? "会形成循环" : connectionSelected ? "✓ 已连接，点击取消" : "＋ 设为前置任务"}</span></button>}
            {draft?.id === node.id && <span className="route-connect-current">正在编辑</span>}
          </article>;
        })}</div>)}
        {!nodes.length && <p className="project-empty-copy">添加第一个任务，开始绘制项目路线。</p>}
      </div></div></div>
    </div>
    <aside className="route-detail-pane" aria-label={draft ? "编辑路线任务" : "任务详情"}>
    {draft ? <form className="route-node-editor route-connection-editor" onSubmit={async (event) => { event.preventDefault(); setError(""); if (await onSave(draft)) setDraft(null); else setError("未能保存，请查看提示并调整后重试。"); }}>
      <header><h3>{draft.id ? "调整任务与连接" : (draft.predecessorIds?.length ?? 0) > 1 ? "汇合到新的任务" : "新建任务"}</h3><Button variant="ghost" type="button" onClick={() => setDraft(null)}>关闭</Button></header>
      <label>任务名称<input autoFocus required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="例如：完成开题报告" /></label>
      <label>完成标准<textarea value={draft.definitionOfDone} onChange={(event) => setDraft({ ...draft, definitionOfDone: event.target.value })} placeholder="这条任务线需要交付什么结果？" /></label>
      <DateField label="截止日期" value={draft.dueDate} onChange={(dueDate) => setDraft({ ...draft, dueDate })} />
      <section className="route-link-picker" aria-label="前置任务连接"><header><div><strong>在图中选择前置任务</strong><p>不选是独立起点，选一个是接续，选多个会形成汇合。</p></div><span>{selectedParents.length ? `${selectedParents.length} 条连线` : "独立起点"}</span></header>{selectedParents.length > 0 && <div className="route-selected-links">{selectedParents.map((id) => { const node = nodes.find((item) => item.id === id); return node ? <button type="button" key={id} onClick={() => togglePredecessor(node)}>{node.title}<span aria-hidden="true">×</span></button> : null; })}</div>}</section>
      {draft.status !== "completed" && <button type="button" className={`route-start-toggle${draft.status === "current" ? " active" : ""}`} aria-pressed={draft.status === "current"} onClick={() => setDraft({ ...draft, status: draft.status === "current" ? "planned" : "current" })}><span>{draft.status === "current" ? "●" : "○"}</span><div><strong>{draft.status === "current" ? "保存后立即开展" : "先保存为待开展"}</strong><small>点击切换；不会暂停其他正在推进的任务</small></div></button>}
      {error && <p role="alert">{error}</p>}
      <footer><span>{draft.predecessorIds?.length ? `已连接 ${draft.predecessorIds.length} 个前置节点` : "独立起点"}</span><Button variant="primary" type="submit" disabled={saving || !draft.title.trim()}>保存任务与连接</Button></footer>
    </form> : selected ? <>
      <div className="route-detail-scroll" key={selected.id}><header><span className={selected.status}>{statusLabel(selected)}</span><h3>{selected.title}</h3></header><div className="route-detail-meta"><span>{selectedTasks.filter((task) => task.status === "done").length}/{selectedTasks.length} 行动完成</span>{selected.dueDate && <time>{selected.dueDate} 截止</time>}</div><h4>完成标准</h4><p>{selected.definitionOfDone || "尚未填写完成标准"}</p>
      {(parents.get(selected.id)?.length ?? 0) > 0 && <div className="route-detail-links"><h4>前置任务</h4>{(parents.get(selected.id) ?? []).map((id) => { const node = nodes.find((item) => item.id === id); return node && <Button key={id} size="small" variant="ghost" onClick={() => setSelectedId(id)}>{node.status === "completed" ? "✓" : "○"} {node.title}</Button>; })}</div>}
      </div>
      <div className="route-detail-actions"><div>{selected.status === "current" && <><Button size="small" variant="primary" onClick={() => onFocus(selected)}>进入任务</Button><Button size="small" variant="secondary" disabled={saving} onClick={() => onComplete(selected)}>完成</Button></>}{selected.status === "planned" && <Button size="small" variant="primary" disabled={saving || selectedBlockers.length > 0} onClick={() => void onSave({ ...selected, predecessorIds: parents.get(selected.id) ?? [], status: "current" })}>{selectedBlockers.length ? `等待 ${selectedBlockers.length} 项完成` : "开展任务"}</Button>}<Button size="small" variant="secondary" onClick={() => edit(selected)}>编辑连接</Button></div><div><Button size="small" variant="ghost" onClick={() => create([selected.id])}>＋ 添加后续</Button><Button size="small" variant="ghost" onClick={() => create(parents.get(selected.id) ?? [])}>⑂ 新建并行任务</Button><Button size="small" variant="danger" disabled={saving} onClick={() => onRemove(selected)}>删除</Button></div></div>
    </> : <p className="project-empty-copy">添加任务后，在这里查看详情。</p>}
    </aside>
    </div>
  </section>;
}
