import { useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { needsResearchReview, researchQueries, type DocumentInput } from "../app/asaba-worker";
import { Button, SelectMenu } from "./DesktopControls";

type ProjectOption = { id: string; title: string };

export function AsabaResearchForm({ initialTopic, busy, onStart, onCancel }: {
  initialTopic: string; busy: boolean;
  onStart: (topic: string, background: string) => void;
  onCancel: () => void;
}) {
  const [topic, setTopic] = useState(initialTopic);
  const [background, setBackground] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const needsReview = needsResearchReview(topic.trim());
  return <form className="asaba-form" onSubmit={event => {
    event.preventDefault();
    if (topic.trim() && !needsReview && (!background.trim() || confirmed)) onStart(topic.trim(), background.trim());
  }}>
    <label><span>公开检索主题</span><textarea rows={2} maxLength={400} value={topic} disabled={busy} onChange={event => setTopic(event.target.value)} placeholder="例如，成都 机器人 ROS2 软件工程师 岗位要求" /></label>
    <small>检索词只填公开信息。个人情况请填在下方。</small>
    {needsReview && <small role="status">请将个人背景移到下方，再填写公开检索词。</small>}
    {topic.trim() && !needsReview && <details><summary>查看会发送的检索词</summary><ul>{researchQueries(topic).map(query => <li key={query}>{query}</li>)}</ul></details>}
    <label><span>仅供 DeepSeek 整理报告时使用的个人背景 · 可选</span><textarea rows={2} maxLength={1500} value={background} disabled={busy} onChange={event => { setBackground(event.target.value); setConfirmed(false); }} placeholder="例如，希望结合某个已确认的学历条件筛选岗位" /></label>
    {background.trim() && <label className="asaba-planning-option"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />确认把上面这段背景发给 DeepSeek</label>}
    <div className="asaba-actions"><Button size="small" variant="primary" type="submit" disabled={busy || !topic.trim() || needsReview || Boolean(background.trim() && !confirmed)}>开始调研</Button><Button size="small" disabled={busy} onClick={onCancel}>返回</Button></div>
  </form>;
}

export function AsabaDocumentForm({ projects, busy, onStart, onCancel, onError }: {
  projects: ProjectOption[]; busy: boolean;
  onStart: (id: string, input: DocumentInput, projectId: string | null) => void;
  onCancel: () => void; onError: (error: string) => void;
}) {
  const [paths, setPaths] = useState<DocumentInput>({ thesis: "", template: "" });
  const [project, setProject] = useState("");
  const id = useRef(crypto.randomUUID());
  async function choose(field: keyof DocumentInput) {
    try {
      const selected = await open({ title: field === "thesis" ? "选择论文" : "选择学校模板", filters: [{ name: "Word 文档", extensions: ["docx"] }] });
      if (typeof selected === "string") {
        id.current = crypto.randomUUID();
        setPaths(current => ({ ...current, [field]: selected }));
      }
    } catch (error) { onError(String(error)); }
  }
  return <form className="asaba-form" onSubmit={event => {
    event.preventDefault();
    if (paths.thesis && paths.template && paths.thesis !== paths.template) onStart(id.current, paths, project || null);
  }}>
    <p>在本机只读比较两份 Word 文档。</p>
    {(["thesis", "template"] as const).map(field => <div key={field} className="asaba-actions">
      <Button size="small" disabled={busy} onClick={() => void choose(field)}>{field === "thesis" ? "选择论文" : "选择学校模板"}</Button>
      <small>{paths[field].split(/[\\/]/).pop()}</small>
    </div>)}
    <SelectMenu label="关联项目" value={project} disabled={busy} onChange={value => { setProject(value); id.current = crypto.randomUUID(); }}
      options={[{ value: "", label: "暂不关联项目" }, ...projects.map(item => ({ value: item.id, label: item.title }))]} />
    <div className="asaba-actions"><Button size="small" variant="primary" type="submit" disabled={busy || !paths.thesis || !paths.template || paths.thesis === paths.template}>开始检查</Button><Button size="small" disabled={busy} onClick={onCancel}>返回</Button></div>
  </form>;
}
