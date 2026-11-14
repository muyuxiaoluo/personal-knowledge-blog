import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { AsabaDelegation, CompanionContext } from "../app/companion-types";
import { Button, SelectMenu } from "./DesktopControls";
import { companionApi } from "./companionApi";

export type DelegationSource = Pick<AsabaDelegation, "noteId" | "projectId" | "title" | "description" | "repository"> &
  Partial<Pick<AsabaDelegation, "agent" | "workspaceMode" | "previousJobId">>;

export function AsabaDelegationForm({ initial, projects, busy, onSubmit }: {
  initial: AsabaDelegation;
  projects: NonNullable<CompanionContext["projects"]>;
  busy: boolean;
  onSubmit: (request: AsabaDelegation) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [repository, setRepository] = useState<{ directory: string; dirty: boolean } | null>(null);
  const [checkVersion, setCheckVersion] = useState(0);
  const [checking, setChecking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [error, setError] = useState("");
  const [beforePolish, setBeforePolish] = useState<string | null>(null);
  const locked = busy || editing || polishing;
  useEffect(() => {
    setRepository(null);
    if (!draft.repository) { setChecking(false); return; }
    let live = true;
    setChecking(true);
    void companionApi.repositoryStatus(draft.repository).then(value => {
      if (live) setRepository(value);
    }).catch(reason => {
      if (live) setError(String(reason));
    }).finally(() => { if (live) setChecking(false); });
    return () => { live = false; };
  }, [draft.repository, checkVersion]);

  async function changeProject(projectId: string) {
    setEditing(true);
    setError("");
    try {
      const repository = projectId ? await companionApi.repository(projectId) : null;
      setDraft(current => ({ ...current, projectId, repository: repository || "" }));
    } catch (reason) { setError(String(reason)); }
    finally { setEditing(false); }
  }

  async function chooseRepository() {
    setEditing(true);
    setError("");
    try {
      const path = await open({ directory: true, title: "选择委托的 Git 仓库" });
      if (typeof path === "string") setDraft(current => ({ ...current, repository: path }));
    } catch (reason) { setError(String(reason)); }
    finally { setEditing(false); }
  }

  async function polish() {
    setPolishing(true);
    setError("");
    try {
      const description = await companionApi.polishDelegation(draft.description);
      setBeforePolish(draft.description);
      setDraft(current => ({ ...current, description }));
    } catch (reason) { setError(String(reason)); }
    finally { setPolishing(false); }
  }

  return <div className="asaba-form">
    <small>{draft.previousJobId ? "继续处理同一条 Bug · Codex" : "新建会话 · Codex"}</small>
    <SelectMenu label="委托归属项目" value={draft.projectId} disabled={locked || !!draft.previousJobId} onChange={projectId => void changeProject(projectId)} options={[{ value: "", label: "不关联项目" }, ...projects.map(project => ({ value: project.id, label: project.title }))]} />
    {draft.repository && <small className="asaba-path">{repository?.directory || draft.repository}</small>}
    {!draft.previousJobId && <Button size="small" disabled={locked} onClick={() => void chooseRepository()}>{draft.repository ? "更换目录" : "选择 Git 仓库"}</Button>}
    <SelectMenu label="执行目录" value={draft.workspaceMode} disabled={locked || !!draft.previousJobId} onChange={value => setDraft(current => ({ ...current, workspaceMode: value === "original" ? "original" : "copy" }))} options={[{ value: "copy", label: "独立副本" }, { value: "original", label: "直接使用项目目录" }]} />
    {checking && <small>正在检查目录改动…</small>}
    {draft.previousJobId && draft.workspaceMode === "copy" ? <small>继续使用上次的独立副本。</small> : repository?.dirty && <p role="status">{draft.workspaceMode === "original" ? "目录有未提交改动。确认后，Agent 将直接在此目录工作。" : "目录有未提交改动。独立副本从当前提交创建。"}</p>}
    {draft.repository && <Button size="small" variant="ghost" disabled={locked || checking} onClick={() => { setError(""); setCheckVersion(version => version + 1); }}>重新检查目录</Button>}
    <textarea aria-label="委托说明" rows={5} maxLength={4000} value={draft.description} disabled={locked} onChange={event => setDraft({ ...draft, description: event.target.value })} />
    <div className="asaba-actions">
      <Button size="small" disabled={locked || !draft.description.trim()} onClick={() => void polish()}>{polishing ? "正在整理说明…" : "浅羽整理说明"}</Button>
      {beforePolish !== null && <Button size="small" variant="ghost" disabled={locked} onClick={() => { setDraft({ ...draft, description: beforePolish }); setBeforePolish(null); }}>撤销整理</Button>}
    </div>
    {error && <small role="status">{error}</small>}
    <Button variant="primary" disabled={locked || checking || !repository || !draft.description.trim()} onClick={() => {
      if (repository) onSubmit({ ...draft, repository: repository.directory, allowLocalChanges: repository.dirty });
    }}>{draft.workspaceMode === "original" ? "确认在原目录执行" : "确认委托"}</Button>
  </div>;
}
