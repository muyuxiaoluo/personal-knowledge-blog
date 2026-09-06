import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, type FormEvent } from "react";
import type { EntertainmentCaptureSnapshot } from "../app/entertainment-capture";
import { formatPlaybackTime, providerLabel } from "../app/entertainment-capture";
import { BrandLogo } from "./BrandLogo";
import { Button } from "./DesktopControls";

type CaptureView = {
  mode: "explore" | "thought";
  snapshot: EntertainmentCaptureSnapshot;
  requiresConfirmation: boolean;
};

export function EntertainmentCaptureApp() {
  const [capture, setCapture] = useState<CaptureView | null>(null);
  const [thought, setThought] = useState("");
  const [quote, setQuote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    document.body.classList.add("capture-window-body");
    void invoke<CaptureView>("entertainment_capture_get_pending")
      .then((value) => {
        setCapture(value);
        setQuote(value.snapshot.selectedText ?? "");
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    const onSaveError = (event: Event) => {
      setBusy(false);
      setError(String((event as CustomEvent<string>).detail || "保存没有完成，请再试一次"));
    };
    window.addEventListener("entertainment-capture-error", onSaveError);
    return () => {
      document.body.classList.remove("capture-window-body");
      window.removeEventListener("entertainment-capture-error", onSaveError);
    };
  }, []);

  async function cancel() {
    if (busy) return;
    await invoke("entertainment_capture_cancel").catch(() => undefined);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!capture || busy || (capture.mode === "thought" && !thought.trim())) return;
    setBusy(true);
    setError("");
    try {
      await invoke("entertainment_capture_submit", {
        thought: thought.trim(),
        quote: quote.trim(),
      });
    } catch (reason) {
      setBusy(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  if (!capture) {
    return <main className="entertainment-capture-app loading"><div className="capture-spinner" /><p>{error || "正在读取当前页面…"}</p>{error && <Button variant="secondary" type="button" onClick={() => void cancel()}>关闭</Button>}</main>;
  }

  const { snapshot } = capture;
  const playback = formatPlaybackTime(snapshot.playbackSeconds);
  const brand = snapshot.provider === "bilibili" ? "bilibili" : "tiktok";

  return (
    <main className="entertainment-capture-app">
      <header className="entertainment-capture-heading">
        <span className={`capture-platform-mark ${snapshot.provider}`}><BrandLogo brand={brand} /></span>
        <div><span>{providerLabel(snapshot.provider)} · {!capture.requiresConfirmation && playback ? `视频 ${playback}` : "当前页面"}</span><h1>{capture.mode === "thought" ? "记录此刻" : "保存当前网页"}</h1></div>
        <Button variant="secondary" size="small" iconOnly type="button" onClick={() => void cancel()} aria-label="关闭">×</Button>
      </header>

      <section className="capture-source-preview">
        <strong title={snapshot.title}>{snapshot.title}</strong>
        <p>{snapshot.author ? `作者：${snapshot.author}` : "将保留原始网址与收集时间"}</p>
      </section>

      {capture.requiresConfirmation && (
        <div className="capture-page-warning"><strong>这不是明确的视频页面</strong><p>当前可能是首页、搜索页或推荐流。确认后仍可把它作为普通网页资料保存。</p></div>
      )}

      <form onSubmit={submit}>
        {capture.mode === "thought" && <>
          <label className="capture-thought-field"><span>这一刻想留下什么？</span><textarea autoFocus value={thought} onChange={(event) => setThought(event.target.value)} placeholder="一句好句、一个启发，或之后准备深入了解的方向……" /></label>
          <label className="capture-quote-field"><span>引用文字 <small>可选</small></span><textarea value={quote} onChange={(event) => setQuote(event.target.value)} placeholder="如果刚才选中了网页文字，会自动出现在这里" /></label>
        </>}
        {error && <p className="entertainment-capture-error" role="alert">{error}</p>}
        <footer>
          <Button variant="secondary" type="button" onClick={() => void cancel()} disabled={busy}>取消</Button>
          <Button variant="primary" type="submit" disabled={busy || (capture.mode === "thought" && !thought.trim())}>
            {busy ? "正在保存…" : capture.mode === "thought" ? "保存到待整理" : "仍保存到探索库"}
          </Button>
        </footer>
      </form>
    </main>
  );
}
