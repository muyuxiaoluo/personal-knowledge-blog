import type { ProjectDateKind } from "../app/project-types";
import { useEffect, useState } from "react";
import { autoScheduleStartDate } from "../app/action-planning";
import { calendarDayDifference, localDate } from "../app/date-helpers";
import { resolveAvailableDeepSeekModel } from "../app/ai-model-settings";
import type { ActionDaysEstimate } from "../app/ai-api-types";
import type { ProjectTaskStep } from "../app/project-types";
import { Button } from "./DesktopControls";
import { desktopApi } from "./integrationApi";

export function ActionEstimateField({ dueDate, dateKind, estimatedDays, title, currentFocus, definitionOfDone, steps, details, projectTitle = "", stageTitle = "", paused = false, onChange, onPauseChange }: {
  dueDate: string;
  dateKind?: ProjectDateKind | null;
  estimatedDays: number;
  title: string;
  currentFocus: string;
  definitionOfDone: string;
  steps: ProjectTaskStep[];
  details: string;
  projectTitle?: string;
  stageTitle?: string;
  paused?: boolean;
  onChange: (days: number) => void;
  onPauseChange?: (paused: boolean) => void;
}) {
  const [suggestion, setSuggestion] = useState<ActionDaysEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const startDate = autoScheduleStartDate(dueDate, estimatedDays);
  const remaining = dueDate ? calendarDayDifference(dueDate, localDate()) : null;

  useEffect(() => { setSuggestion(null); }, [title, currentFocus, definitionOfDone, steps, details, projectTitle, stageTitle]);

  async function suggest() {
    setBusy(true);
    setError("");
    setSuggestion(null);
    try {
      const model = await resolveAvailableDeepSeekModel("nextAction", desktopApi.deepseek.apiModels);
      const response = await desktopApi.deepseek.estimateActionDays({ model, input: {
        title: title.trim(),
        currentFocus: currentFocus.trim(),
        definitionOfDone: definitionOfDone.trim(),
        steps: steps.filter((step) => !step.completed).map((step) => step.title),
        details: details.trim(),
        projectTitle,
        stageTitle,
      }, allowedMilestoneIds: [], allowedTaskIds: [] });
      const value = response.content;
      if (value.days !== null && (!Number.isInteger(value.days) || value.days < 1 || value.days > 365)) throw new Error("AI 返回的预计天数无效");
      setSuggestion(value);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "估计失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return <div className="action-estimate-field">
    <label><span>预计需要几天 · 可选</span><input type="number" min="1" max="365" step="1" value={estimatedDays || ""} onChange={(event) => {
      const value = event.target.value;
      onChange(value === "" ? 0 : Math.min(365, Math.max(1, Number(value) || 1)));
    }} placeholder="例如 3" /></label>
    <Button variant="secondary" size="small" type="button" disabled={busy || !title.trim()} onClick={() => void suggest()}>{busy ? "正在估计…" : "AI 估计"}</Button>
    {suggestion && <div className="action-estimate-suggestion"><p>{suggestion.days === null ? "暂时无法估计" : `AI 建议：${suggestion.days} 天`} · {suggestion.reason}</p>{suggestion.days !== null && <Button variant="secondary" size="small" type="button" onClick={() => { onChange(suggestion.days!); setSuggestion(null); }}>采用建议</Button>}</div>}
    {error && <p className="action-estimate-error" role="alert">{error}</p>}
    {startDate && <p className="action-estimate-note">状态为“下一步”时，预计从 {startDate} 起自动安排到今日；完成前每天继续显示。</p>}
    {estimatedDays > 0 && !dueDate && <p className="action-estimate-note">确认行动日期后开始按工期安排。</p>}
    {remaining !== null && estimatedDays > remaining && estimatedDays > 0 && <p className="action-estimate-warning">{dateKind === "deadline" ? (remaining < 0 ? `已逾期 ${-remaining} 天` : `距截止还剩 ${remaining} 天`) : (remaining < 0 ? `已过目标日 ${-remaining} 天` : `距目标日还剩 ${remaining} 天`)}，预计需要 {estimatedDays} 天；请调整范围或日期。</p>}
    {onPauseChange && paused && <div className="action-estimate-resume"><span>自动安排已暂停</span><Button variant="secondary" size="small" type="button" onClick={() => onPauseChange(false)}>恢复自动安排</Button></div>}
  </div>;
}
