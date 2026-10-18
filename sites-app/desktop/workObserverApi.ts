import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ObserverConfig, ObserverStatus } from "../app/work-observer-types";

function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new Error("请在桌面应用中使用工作观察。"));
  return invoke<T>(command, args);
}
export const workObserverApi = {
  status: () => call<ObserverStatus>("work_observer_status"),
  configure: (config: ObserverConfig) => call<ObserverStatus>("work_observer_configure", { config }),
  enable: (enabled: boolean) => call<ObserverStatus>("work_observer_set_enabled", { enabled }),
  capture: () => call<ObserverStatus>("work_observer_capture"),
  image: (id: string) => call<string | null>("work_observer_image", { id }),
};
