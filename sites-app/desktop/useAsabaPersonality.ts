import { useEffect, useRef, useState } from "react";
import { asabaMaySpeak, asabaMoment, asabaPlayKind, type AsabaMoment, type AsabaMomentKind } from "./asaba-personality";

type Options = { mood: string; reaction: string; enabled: boolean; smalltalk: boolean; quiet: boolean; resultId?: string };
export function useAsabaPersonality(options: Options) {
  const [moment, setMoment] = useState<(AsabaMoment & { id: number }) | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const turn = useRef(0);
  const lastAt = useRef(Date.now());
  const lastPat = useRef(-Infinity);
  const serial = useRef(0);
  const dismiss = useRef<number | undefined>(undefined);
  const result = useRef(options.resultId);

  function show(kind: AsabaMomentKind, automatic: boolean) {
    const current = latest.current;
    if (!asabaMaySpeak({ automatic, enabled: current.enabled && current.smalltalk, quiet: current.quiet,
      visible: !document.hidden, now: Date.now(), lastAt: lastAt.current })) return;
    const next = asabaMoment(kind, turn.current++);
    lastAt.current = Date.now();
    window.clearTimeout(dismiss.current);
    setMoment({ ...next, text: current.smalltalk ? next.text : "", id: ++serial.current });
    dismiss.current = window.setTimeout(() => setMoment(null), 6500);
  }

  useEffect(() => () => window.clearTimeout(dismiss.current), []);
  useEffect(() => {
    if (options.quiet) setMoment(null);
  }, [options.quiet]);
  useEffect(() => {
    if (options.reaction !== "pat" || performance.now() - lastPat.current < 15_000) return;
    lastPat.current = performance.now();
    show("pat", false);
  }, [options.reaction]);
  useEffect(() => {
    const kind = { curious: "curious", focused: "work", excited: "cheer" }[options.mood] as AsabaMomentKind | undefined;
    if (kind) show(kind, true);
  }, [options.mood]);
  useEffect(() => {
    if (result.current && options.resultId && result.current !== options.resultId) show("result", true);
    result.current = options.resultId;
  }, [options.resultId]);
  useEffect(() => {
    const timer = window.setInterval(() => show(asabaPlayKind(turn.current, new Date().getHours()), true), 15_000);
    const visibility = () => { if (document.hidden) setMoment(null); };
    document.addEventListener("visibilitychange", visibility);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, []);

  return { moment, play: () => show(asabaPlayKind(turn.current, new Date().getHours()), false) };
}
