import React from "react";
import ReactDOM from "react-dom/client";
import "./desktop.css";
import { DesktopApp } from "./DesktopApp";
import { ConfirmDialogProvider } from "./DesktopControls";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@tauri-apps/api/core";
import { EntertainmentCaptureApp } from "./EntertainmentCaptureApp";

const captureWindow = isTauri() && getCurrentWindow().label === "entertainment-capture";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {captureWindow
      ? <EntertainmentCaptureApp />
      : <ConfirmDialogProvider><DesktopApp /></ConfirmDialogProvider>}
  </React.StrictMode>,
);
