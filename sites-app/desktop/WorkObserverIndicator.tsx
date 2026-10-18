import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import type { ObserverStatus } from "../app/work-observer-types";
import { Button } from "./DesktopControls";
import { workObserverApi } from "./workObserverApi";

export function ObserverIndicator({ onOpen }: { onOpen: () => void }) {
  const [status, setStatus] = useState<ObserverStatus | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () => void workObserverApi.status().then((value) => { if (active) setStatus(value); }).catch(() => {});
    refresh();
    const subscription = listen("work-observer-changed", refresh);
    return () => { active = false; void subscription.then((unlisten) => unlisten()); };
  }, []);
  if (!status?.enabled && !status?.busy) return null;
  return <Button size="small" className="observer-indicator" onClick={onOpen}><span aria-hidden="true">●</span>{status.busy ? "正在观察" : "工作观察已开启"}</Button>;
}
