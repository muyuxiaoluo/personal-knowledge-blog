import { useEffect, useId, useRef } from "react";
import type { WorkspaceTask } from "./WorkPages";
import { formatRelativeDueDate } from "../app/date-helpers";

export function HomeNextActions({ tasks, onOpenTask }: { tasks: WorkspaceTask[]; onOpenTask: (id: string) => void }) {
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: Event) => {
      const panel = panelRef.current;
      if (event.target instanceof Node && panel?.contains(event.target)) return;
      if (panel?.matches(":popover-open")) panel.hidePopover();
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => { window.removeEventListener("resize", close); window.removeEventListener("scroll", close, true); };
  }, []);
  return <>
    <button className="workspace-card home-next-trigger" type="button" data-home-tile popoverTarget={id} onClick={(event) => {
      const panel = panelRef.current;
      if (!panel) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 32);
      panel.style.width = `${width}px`;
      panel.style.left = `${Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))}px`;
      const below = window.innerHeight - rect.bottom - 24;
      panel.style.top = below >= 160 ? `${rect.bottom + 8}px` : "auto";
      panel.style.bottom = below >= 160 ? "auto" : `${window.innerHeight - rect.top + 8}px`;
      panel.style.maxHeight = `${Math.max(120, below >= 160 ? below : rect.top - 24)}px`;
    }}><strong>接下来</strong><span>{tasks.length} 项备选行动</span><i aria-hidden="true">⌄</i></button>
    <div ref={panelRef} id={id} className="home-next-popover" popover="auto" aria-label="备选行动">
      {tasks.map((task) => <button type="button" key={task.id} title={task.currentFocus || task.title} onClick={() => { panelRef.current?.hidePopover(); onOpenTask(task.id); }}>
        <span><strong>{task.currentFocus || task.title}</strong><small>{task.projectTitle}</small></span><em>{task.dueDate ? formatRelativeDueDate(task.dueDate) : "稍后"}</em>
      </button>)}
    </div>
  </>;
}
