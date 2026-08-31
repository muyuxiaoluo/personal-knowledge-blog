import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";

const captureWindow = isTauri() && getCurrentWindow().label === "entertainment-capture";
const WindowRoot = lazy(() => captureWindow
  ? import("./EntertainmentRoot")
  : import("./DesktopRoot"));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={null}><WindowRoot /></Suspense>
  </React.StrictMode>,
);
