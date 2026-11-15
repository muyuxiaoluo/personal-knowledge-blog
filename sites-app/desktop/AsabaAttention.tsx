import type { AttentionCommand, AttentionGroup } from "../app/asaba-attention";
import { localDate } from "../app/date-helpers";
import { Button } from "./DesktopControls";

const jobResult = { review: "成果待确认", completed: "委托已完成", failed: "委托失败", interrupted: "委托已中断" };

export function AsabaAttention({ groups, busy, onCommand, onOpen }: {
  groups: AttentionGroup[];
  busy: boolean;
  onCommand: (command: AttentionCommand) => void;
  onOpen: (kind: "project" | "task" | "source" | "job", id: string, keys: string[]) => void;
}) {
  const today = localDate();
  if (!groups.length) return <p>当前没有待关注的事项。</p>;
  return <div className="asaba-attention-list">
    {groups.map(group => {
      const keys = group.entries.map(entry => entry.key);
      const unread = group.entries.some(entry => entry.unread);
      return <article className="asaba-attention-card" key={group.kind + group.id}>
        <header>
          <small>{group.kind === "project" ? "项目" : group.kind === "job" ? "后台委托" : "收藏建议"}{unread && " · 未读"}</small>
          <strong>{group.title}</strong>
        </header>
        <ul>{group.entries.map(entry => <li key={entry.key}>
          {(entry.kind === "deadline" || entry.kind === "review") && <>
            <span>{entry.kind === "review" ? "项目回顾" : entry.title} · {entry.date} · {entry.kind === "review" ? "待回顾" : entry.date < today ? "已逾期" : "今天截止"}</span>
            {entry.taskId && <Button size="small" variant="ghost" disabled={busy} onClick={() => onOpen("task", entry.taskId!, [entry.key])}>打开行动</Button>}
          </>}
          {entry.kind === "job" && <span>{jobResult[entry.state]}</span>}
          {entry.kind === "source" && group.kind === "source" && <>
            <span>《{entry.title}》的{entry.basis === "title" ? "标题包含" : "标签匹配"}完整项目名</span>
            <div className="asaba-actions">
              <Button size="small" variant="primary" disabled={busy} onClick={() => onCommand({ kind: "link", key: entry.key, sourceId: entry.sourceId, projectId: group.projectId })}>确认关联</Button>
              <Button size="small" disabled={busy} onClick={() => onOpen("source", entry.sourceId, [entry.key])}>打开收藏</Button>
            </div>
          </>}
        </li>)}</ul>
        <div className="asaba-actions">
          {group.kind === "project" && <Button size="small" disabled={busy} onClick={() => onOpen("project", group.projectId, keys)}>打开项目</Button>}
          {group.kind === "job" && <Button size="small" disabled={busy} onClick={() => onOpen("job", group.jobId, keys)}>查看委托</Button>}
          {unread && <Button size="small" variant="ghost" disabled={busy} onClick={() => onCommand({ kind: "read", keys })}>标为已读</Button>}
          <Button size="small" variant="ghost" disabled={busy} onClick={() => onCommand({ kind: "dismiss", keys })}>忽略</Button>
        </div>
      </article>;
    })}
  </div>;
}
