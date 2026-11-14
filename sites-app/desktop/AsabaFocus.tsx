import { useEffect, useState } from "react";
import type { AsabaActivity, CompanionContext } from "../app/companion-types";
import { companionApi } from "./companionApi";
import { Button, SelectMenu } from "./DesktopControls";

export function focusElapsed(startedAt: string, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  return [Math.floor(minutes / 60), minutes % 60, seconds % 60].map(value => value.toString().padStart(2, "0")).join(":");
}

export function useAsabaFocus(context: CompanionContext | undefined, enabled: boolean) {
  const [time, setTime] = useState(Date.now());
  const [activity, setActivity] = useState<AsabaActivity | null>(null);
  const [dismissed, setDismissed] = useState({ application: "", until: 0 });
  const session = context?.activeFocus;
  useEffect(() => {
    if (!session) return;
    const interval = window.setInterval(() => setTime(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [session?.id]);
  useEffect(() => {
    if (!enabled) { setActivity(null); return; }
    let alive = true;
    const refresh = () => void companionApi.activity().then(value => { if (alive) setActivity(value); }).catch(() => {});
    refresh();
    const interval = window.setInterval(refresh, 15000);
    return () => { alive = false; window.clearInterval(interval); };
  }, [enabled]);
  const workApplication = /^(?:codex|code|trae|cursor|devenv|pycharm64|idea64|clion64|winword|excel|powerpnt|wps|et|wpp|obs64)\.exe$/i.test(activity?.application || "");
  const suggest = Boolean(enabled && !session && workApplication && activity?.available && activity.continuousSeconds >= 600
    && (dismissed.application !== activity.application || dismissed.until < Date.now()));
  return {
    activity,
    elapsed: session ? focusElapsed(session.startedAt, time) : "",
    suggestion: suggest ? activity?.application : undefined,
    idle: Boolean(session && activity && (!activity.available || activity.idleSeconds >= 300)),
    dismiss: () => setDismissed({ application: activity?.application || "", until: Date.now() + 30 * 60000 }),
  };
}

export function AsabaFocusPanel({ context, suggestedApplication, onChanged, onError }: {
  context: CompanionContext; suggestedApplication?: string; onChanged: () => void; onError: (text: string) => void;
}) {
  const [label, setLabel] = useState(() => suggestedApplication ? "在 " + suggestedApplication.replace(/\.exe$/i, "") + " 中工作" : "");
  const [projectId, setProjectId] = useState("");
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  async function start(taskId?: string) {
    if (saving) return;
    setSaving(true);
    try {
      await companionApi.focus({ id: crypto.randomUUID(), operation: "start", taskId, label, projectId });
      onChanged();
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }
  const tasks = query.trim() ? context.tasks?.filter(task => (task.title + " " + task.projectTitle).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).slice(0, 5) ?? [] : [];
  return <form className="asaba-form" onSubmit={event => { event.preventDefault(); void start(); }}>
    <label className="asaba-field">这会儿做什么
      <input aria-label="投入名称" maxLength={120} placeholder="例如，复现刚才的游戏问题" value={label} onChange={event => setLabel(event.target.value)} />
    </label>
    <SelectMenu label="投入关联项目" value={projectId} onChange={setProjectId} options={[{ value: "", label: "暂不关联项目" }, ...(context.projects ?? []).map(project => ({ value: project.id, label: project.title }))]} />
    <Button variant="primary" type="submit" disabled={saving || !label.trim()}>开始计时</Button>
    <details className="asaba-details"><summary>从已有行动开始</summary>
      <input aria-label="查找已有行动" placeholder="输入行动或项目名" value={query} onChange={event => setQuery(event.target.value)} />
      {tasks.map(task => <Button key={task.id} size="small" variant="ghost" disabled={saving} onClick={() => void start(task.id)}>{task.title}</Button>)}
      {query.trim() && !tasks.length && <p>没有找到对应行动，可以直接记上方的名称。</p>}
    </details>
  </form>;
}

