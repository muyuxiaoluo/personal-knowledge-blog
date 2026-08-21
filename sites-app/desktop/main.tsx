import React from "react";
import ReactDOM from "react-dom/client";
import "./desktop.css";
import { DesktopApp } from "./DesktopApp";
import { ConfirmDialogProvider } from "./DesktopControls";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfirmDialogProvider><DesktopApp /></ConfirmDialogProvider>
  </React.StrictMode>,
);
