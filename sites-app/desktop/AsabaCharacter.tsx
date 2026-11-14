import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import neutral from "./asaba-motion/neutral.webp";
import catalogue from "./asaba-motion/manifest.json";
import { AsabaMotionRenderer } from "./asaba-motion-renderer";
import type { MotionStats } from "./asaba-motion-clock";

const pages = import.meta.glob<string>(["./asaba-motion/*.webp", "!./asaba-motion/spin-*.webp"], { eager: true, query: "?url", import: "default" });
type Probe = MotionStats & { clip: string; pages: number; error: string };

export function AsabaCharacter({ state, animate, pointer }: { state: string; animate: boolean; pointer: RefObject<{ x: number; y: number }> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<AsabaMotionRenderer | null>(null);
  const target = useRef(pointer); target.current = pointer;
  const [ready, setReady] = useState(false);
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [probing, setProbing] = useState(false);
  const [stats, setStats] = useState<Probe | null>(null);
  const [failure, setFailure] = useState("");

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches);
    media.addEventListener("change", change);
    try {
      renderer.current = new AsabaMotionRenderer(canvas.current!, catalogue, {
        url: name => pages["./asaba-motion/" + name], pointer: () => target.current.current,
        ready: setReady, stats: setStats,
      });
    } catch (error) { setFailure(String(error)); console.warn("浅羽使用静态站姿", error); }
    return () => { media.removeEventListener("change", change); renderer.current?.dispose(); renderer.current = null; };
  }, []);
  useEffect(() => { renderer.current?.setState(state); }, [state]);
  useEffect(() => { renderer.current?.setEnabled(animate && !reduced); }, [animate, reduced]);
  useEffect(() => { renderer.current?.setProbe(probing); }, [probing]);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const key = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.altKey && event.shiftKey && (event.code === "F8" || event.key === "F8")) { event.preventDefault(); setProbing(value => !value); }
    };
    const toggle = () => setProbing(value => !value);
    window.addEventListener("keydown", key);
    window.addEventListener("asaba-motion-probe", toggle);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("asaba-motion-probe", toggle); };
  }, []);

  return <span className="asaba-character">
    <img className="asaba-avatar" src={neutral} alt="" draggable={false} style={{ visibility: ready ? "hidden" : "visible" }} />
    <canvas className="asaba-avatar asaba-motion-canvas" ref={canvas} aria-hidden="true" style={{ visibility: ready ? "visible" : "hidden" }} />
    {import.meta.env.DEV && probing && createPortal(<output className="asaba-motion-probe" aria-label="动画测量">
      {failure || (stats ? `绘制 ${stats.hz.toFixed(1)} Hz\nP95 ${stats.p95.toFixed(1)} ms\n长帧 ${stats.longFrames}\n资源停等 ${stats.waiting}\n跳帧 ${stats.skipped}\n解码 ${stats.decodeMs.toFixed(1)} ms\n页缓存 ${stats.pages}\n${stats.clip} · ${stats.seconds.toFixed(0)} s${stats.error ? "\n" + stats.error : ""}` : "动画测量中")}
    </output>, document.body)}
  </span>;
}
