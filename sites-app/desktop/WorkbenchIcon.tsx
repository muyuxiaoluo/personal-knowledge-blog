export type WorkbenchIconName =
  | "brand"
  | "home"
  | "today"
  | "projects"
  | "notes"
  | "explore"
  | "inbox"
  | "review"
  | "ai"
  | "tools"
  | "settings"
  | "account"
  | "update";

export function WorkbenchIcon({ name, className = "" }: { name: WorkbenchIconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {name === "brand" && <><path d="M4 5.5c2.8-.9 5.3-.5 8 1.2v12c-2.7-1.7-5.2-2.1-8-1.2z" /><path d="M20 5.5c-2.8-.9-5.3-.5-8 1.2" /><path d="M16.8 2.8v4.4M14.6 5h4.4" /></>}
      {name === "home" && <><path d="m3.5 10 8.5-7 8.5 7" /><path d="M5.5 9v11h13V9" /><path d="M9.5 20v-6h5v6" /></>}
      {name === "today" && <><rect x="3" y="4.5" width="18" height="16" rx="2.5" /><path d="M7 2.5v4M17 2.5v4M3 9h18" /><path d="m8 14 2.2 2.2L16 11.5" /></>}
      {name === "projects" && <><circle cx="5" cy="18" r="2" /><circle cx="12" cy="6" r="2" /><circle cx="19" cy="15" r="2" /><path d="m6.4 16.6 4.2-8.8M13.7 7.4l3.7 6.2M7 18h10" /></>}
      {name === "notes" && <><path d="M6 3h9l4 4v14H6z" /><path d="M15 3v5h4M9 12h7M9 16h7" /></>}
      {name === "explore" && <><circle cx="12" cy="12" r="9" /><path d="m15.7 8.3-2.2 5.2-5.2 2.2 2.2-5.2z" /></>}
      {name === "inbox" && <><path d="M4 5h16l2 10v4H2v-4z" /><path d="M2 15h5l2 2h6l2-2h5" /></>}
      {name === "review" && <><path d="M20 11a8 8 0 1 1-2.3-5.7" /><path d="M20 4v7h-7" /><path d="M12 7v5l3 2" /></>}
      {name === "ai" && <><path d="M8 4h8a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4h-3l-4 3v-3H8a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4Z" /><path d="M9 10h.01M15 10h.01M9 14h6" /></>}
      {name === "tools" && <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><path d="M17.5 14v7M14 17.5h7" /></>}
      {name === "settings" && <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21h-4v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3.1 14H3v-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V3h4v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.1v4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>}
      {name === "account" && <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.7-4 3.1-6 7-6s6.3 2 7 6" /></>}
      {name === "update" && <><path d="M20 11a8 8 0 1 1-2.3-5.7" /><path d="M20 4v7h-7" /><path d="M12 8v4l2.7 1.7" /></>}
    </svg>
  );
}
