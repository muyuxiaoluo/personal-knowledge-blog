import "./desktop.css";
import { DesktopApp } from "./DesktopApp";
import { ConfirmDialogProvider } from "./DesktopControls";

export default function DesktopRoot() {
  return <ConfirmDialogProvider><DesktopApp /></ConfirmDialogProvider>;
}
