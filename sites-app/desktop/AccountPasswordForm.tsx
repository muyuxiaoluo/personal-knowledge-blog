import { useState, type FormEvent } from "react";
import { Button } from "./DesktopControls";
import { errorMessage } from "../app/data/error-message";

export function AccountPasswordForm({ disabled, onChangePassword }: {
  disabled: boolean;
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || disabled) return;
    if (next !== confirmation) { setError("两次输入的新密码不一致。"); return; }
    if (next === current) { setError("新密码不能与当前密码相同。"); return; }
    setBusy(true);
    setError("");
    try {
      await onChangePassword(current, next);
      setCurrent(""); setNext(""); setConfirmation("");
    } catch (cause) { setError(errorMessage(cause, "密码修改未完成，请重试。")); }
    finally { setBusy(false); }
  }
  return <details className="account-password">
    <summary>修改密码</summary>
    <form onSubmit={submit}>
      <p>修改后，手机和电脑都需要重新登录，已有记录会保留。</p>
      <label><span>当前密码</span><input type="password" autoComplete="current-password" required value={current} onChange={event => setCurrent(event.target.value)} disabled={busy} /></label>
      <label><span>新密码</span><input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={next} onChange={event => setNext(event.target.value)} disabled={busy} /><small>至少 12 个字符。</small></label>
      <label><span>确认新密码</span><input type="password" autoComplete="new-password" required value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} /></label>
      {error && <p role="alert">{error}</p>}
      <Button variant="primary" type="submit" disabled={busy || disabled}>{busy ? "正在修改…" : "保存新密码"}</Button>
    </form>
  </details>;
}
