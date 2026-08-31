import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export type SelectOption = { value: string; label: string; disabled?: boolean };

const SELECT_MENU_GAP = 6;
const SELECT_MENU_VIEWPORT_MARGIN = 12;

/** 计算下拉菜单的固定定位：下方空间不足时向上展开，并把高度限制在展开侧的可用空间内，避免选项被视口裁切 */
function getMenuPosition(rect: DOMRect): { left: number; top?: number; bottom?: number; minWidth: number; maxHeight: number } {
  const spaceBelow = window.innerHeight - rect.bottom - SELECT_MENU_VIEWPORT_MARGIN;
  const spaceAbove = rect.top - SELECT_MENU_VIEWPORT_MARGIN;
  const openUpward = spaceBelow < 240 && spaceAbove > spaceBelow;
  const maxHeight = Math.min(360, Math.max(140, openUpward ? spaceAbove : spaceBelow));
  return {
    left: rect.left,
    top: openUpward ? undefined : rect.bottom + SELECT_MENU_GAP,
    bottom: openUpward ? window.innerHeight - rect.top + SELECT_MENU_GAP : undefined,
    minWidth: rect.width,
    maxHeight,
  };
}

export function SelectMenu({ value, options, onChange, label, disabled = false, className = "" }: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    const index = Math.max(0, options.findIndex((option) => option.value === value));
    setActiveIndex(index);
    const onPointerDown = (event: PointerEvent) => {
      if (triggerRef.current?.contains(event.target as Node) || listRef.current?.contains(event.target as Node)) return;
      close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.requestAnimationFrame(() => listRef.current?.focus());
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [close, open, options, value]);

  function move(direction: 1 | -1) {
    let next = activeIndex;
    do next = (next + direction + options.length) % options.length;
    while (options[next]?.disabled && next !== activeIndex);
    setActiveIndex(next);
  }

  function choose(option: SelectOption) {
    if (option.disabled) return;
    onChange(option.value);
    close();
  }

  const rect = open ? triggerRef.current?.getBoundingClientRect() : null;
  const menuPosition = rect ? getMenuPosition(rect) : null;
  return <div className={`ui-select ${className}`}>
    <button
      ref={triggerRef}
      type="button"
      className="ui-select-trigger"
      aria-label={label}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={`${id}-listbox`}
      disabled={disabled}
      onClick={() => setOpen((current) => !current)}
      onKeyDown={(event) => {
        if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
          event.preventDefault();
          setOpen(true);
        }
      }}
    ><span>{selected?.label ?? "请选择"}</span><i aria-hidden="true">⌄</i></button>
    {open && rect && createPortal(<div
      ref={listRef}
      id={`${id}-listbox`}
      className="ui-select-menu"
      role="listbox"
      tabIndex={-1}
      aria-label={label}
      style={menuPosition ?? undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Tab") return close(event.key === "Escape");
        if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
        if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
        if (event.key === "Home") { event.preventDefault(); setActiveIndex(0); }
        if (event.key === "End") { event.preventDefault(); setActiveIndex(options.length - 1); }
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(options[activeIndex]); }
      }}
    >{options.map((option, index) => <button
      type="button"
      role="option"
      aria-selected={option.value === value}
      disabled={option.disabled}
      className={`${option.value === value ? "selected" : ""} ${index === activeIndex ? "active" : ""}`}
      key={option.value}
      onMouseEnter={() => setActiveIndex(index)}
      onClick={() => choose(option)}
    ><span>{option.label}</span>{option.value === value && <i>✓</i>}</button>)}</div>, document.body)}
  </div>;
}

export function SearchField({ value, onChange, placeholder, label = "搜索" }: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label?: string;
}) {
  return <label className="ui-search"><span aria-hidden="true">⌕</span><input aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />{value && <button type="button" onClick={() => onChange("")} aria-label="清空搜索">×</button>}</label>;
}

export function DateField({ value, onChange, label, optional = true, className = "" }: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  optional?: boolean;
  className?: string;
}) {
  return <label className={`ui-date-field ${className}`}><span>{label}{optional && <em>可选</em>}</span><div><input type="date" value={value} onChange={(event) => onChange(event.target.value)} />{value && <button type="button" onClick={() => onChange("")} aria-label={`清除${label}`}>×</button>}</div></label>;
}

type ConfirmOptions = {
  title: string;
  subject?: ReactNode;
  description: ReactNode;
  descriptionIcon?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "warning";
};
type ConfirmRequest = ConfirmOptions & { resolve: (value: boolean) => void };
const ConfirmContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    setRequest({ ...options, resolve });
  }), []);
  const finish = useCallback((value: boolean) => {
    setRequest((current) => { current?.resolve(value); return null; });
    window.requestAnimationFrame(() => previousFocus.current?.focus());
  }, []);

  useEffect(() => {
    if (!request) return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [];
    focusable[focusable.length - 1]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); finish(false); return; }
      if (event.key !== "Tab" || !focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [finish, request]);

  return <ConfirmContext.Provider value={confirm}>{children}{request && createPortal(
    <div className="ui-dialog-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) finish(false); }}>
      <div className={`ui-confirm-dialog ${request.tone ?? "warning"}`} ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby="ui-confirm-title" aria-describedby="ui-confirm-description">
        <header className="ui-confirm-header">
          <span className="ui-confirm-icon" aria-hidden="true">{request.tone === "danger" ? "!" : "?"}</span>
          <div>
            <span className="ui-confirm-eyebrow">{request.tone === "danger" ? "删除确认" : "操作确认"}</span>
            <h2 id="ui-confirm-title">{request.title}</h2>
          </div>
        </header>
        {request.subject && <div className="ui-confirm-subject"><span>即将删除</span><strong>{request.subject}</strong></div>}
        <div className="ui-confirm-description" id="ui-confirm-description"><span aria-hidden="true">{request.descriptionIcon ?? "i"}</span><div>{request.description}</div></div>
        <footer><button type="button" onClick={() => finish(false)}>{request.cancelLabel ?? "取消"}</button><button type="button" className={request.tone === "danger" ? "danger" : "primary"} onClick={() => finish(true)}>{request.confirmLabel ?? "确认"}</button></footer>
      </div>
    </div>, document.body,
  )}</ConfirmContext.Provider>;
}

export function useConfirmDialog() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirmDialog must be used within ConfirmDialogProvider");
  return confirm;
}
