import { formatAsabaEvidenceDate, type AsabaProjectDecision } from "../app/asaba-planning";
import { Button } from "./DesktopControls";

const decisionLabels = {
  continue: "继续已有行动", new_action: "新增一项行动", clarify: "需要确认", wait: "等待条件",
  delegate: "可委托的工作", adjust: "建议局部调整", keep: "维持现状",
};

export function ProjectDecisionResult({ result, disabled, onContinue, onDelegate, onAdjust }: {
  result: AsabaProjectDecision;
  disabled?: boolean;
  onContinue: (id: string) => void;
  onDelegate: () => void;
  onAdjust: () => void;
}) {
  const { answer, evidence, existingAction } = result;
  const decisionSources = new Set([...(answer.decisionEvidenceIds ?? []), ...(answer.taskEvidenceId ? [answer.taskEvidenceId] : [])]);
  const showSources = (ids: Set<string>) => evidence.filter(source => ids.has(source.id)).map(source => <details className="asaba-details" key={source.id}>
    <summary>{source.title || "项目记录"}{source.date ? " · " + formatAsabaEvidenceDate(source.date) : ""}</summary>
    {source.text && <p>{source.text}</p>}
  </details>);
  return <section className="asaba-planning-preview project-decision-result" aria-label="项目建议">
    <strong>{answer.decision ? decisionLabels[answer.decision] : "项目进展"}</strong>
    <p>{answer.summary}</p>
    {result.investigation && <small>{result.investigation}</small>}
    {answer.unknowns.map((value, index) => <p key={index}>{value}</p>)}
    {(answer.decision === "delegate" || answer.decision === "adjust") && <p>{answer.nextAction}</p>}
    {answer.decision === "delegate" && answer.completionCondition && <p>验收条件 · {answer.completionCondition}</p>}
    {showSources(decisionSources)}
    {answer.findings.length > 0 && <ul>{answer.findings.map((finding, index) => <li key={index}>{finding.text}{showSources(new Set(finding.evidenceIds))}</li>)}</ul>}
    {(existingAction || answer.decision === "delegate" || result.canAdjust) && <div className="asaba-actions">
      {existingAction && <Button type="button" size="small" disabled={disabled} onClick={() => onContinue(existingAction.id)}>继续 · {existingAction.title}</Button>}
      {answer.decision === "delegate" && <Button type="button" size="small" disabled={disabled} onClick={onDelegate}>打开 Codex 委托</Button>}
      {result.canAdjust && <Button type="button" size="small" disabled={disabled} onClick={onAdjust}>打开计划调整</Button>}
    </div>}
  </section>;
}
