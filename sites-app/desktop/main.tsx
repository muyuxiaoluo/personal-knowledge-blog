import React from "react";
import ReactDOM from "react-dom/client";
import "./desktop.css";
import { DesktopApp } from "./DesktopApp";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DesktopApp />
  </React.StrictMode>,
);
