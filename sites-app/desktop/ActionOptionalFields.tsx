import { useEffect, useState, type ReactNode } from "react";

export function ActionOptionalFields({ children, hasContent = false }: { children: ReactNode; hasContent?: boolean }) {
  const [open, setOpen] = useState(hasContent);
  useEffect(() => { if (hasContent) setOpen(true); }, [hasContent]);
  return <details className="action-optional-fields" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>补充推进范围、完成标志与步骤 · 可选</summary>
    <div>{children}</div>
  </details>;
}
