import type { ProjectDateKind } from "../app/project-types";
import { DateField, SelectMenu } from "./DesktopControls";

export function ProjectDateField({ label, value, kind, onChange, className }: {
  label: string; value: string; kind?: ProjectDateKind | null; className?: string;
  onChange: (date: string, kind: ProjectDateKind | null) => void;
}) {
  return <div className={className}>
    <DateField label={label} value={value} onChange={(date) => onChange(date, date ? (kind ?? (value ? null : "target")) : null)} />
    {value && <SelectMenu label={`${label}用途`} value={kind ?? ""} onChange={(choice) => onChange(value, choice ? choice as ProjectDateKind : null)} options={[
      { value: "", label: "日期待确认" }, { value: "target", label: "计划目标" }, { value: "deadline", label: "真实截止" },
    ]} />}
  </div>;
}
