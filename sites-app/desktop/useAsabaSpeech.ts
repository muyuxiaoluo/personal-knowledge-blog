import { useEffect, useRef, useState } from "react";
import { companionApi } from "./companionApi";

type AudioState = "off" | "preparing" | "playing" | "paused" | "error";
type Session = {
  cancelled: boolean; paused: boolean;
  release?: () => void; resumes: Set<() => void>; player?: HTMLAudioElement;
};
type Readout = { parts: string[]; index: number };

export function asabaSpeechSegments(text: string) {
  const clean = text
    .replace(/\x60{3}[\s\S]*?\x60{3}/g, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/[^\s，。；！？]+/g, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)、]\s+)/gm, "")
    .replace(/[\x60*#<>|]/g, "")
    .replace(/\r?\n+/g, "。")
    .replace(/[。]{2,}/g, "。");
  const sentences = clean.match(/[^。！？!?；;]+[。！？!?；;]*/gu) ?? [];
  const parts: string[] = [];
  for (const sentence of sentences) {
    const clauses = sentence.match(/[^，,、]+[，,、]*/gu) ?? [];
    let pending = "";
    for (const clause of clauses) {
      const chars = Array.from(clause.trim());
      if (Array.from(pending).length + chars.length > 28 && pending) {
        parts.push(pending);
        pending = "";
      }
      while (chars.length > 28) parts.push(chars.splice(0, 28).join(""));
      pending += chars.join("");
    }
    if (pending.trim()) parts.push(pending.trim());
  }
  return parts;
}

export function useAsabaSpeech(onError: (message: string) => void) {
  const [audio, setAudio] = useState<AudioState>("off");
  const [progress, setProgress] = useState<{ index: number; total: number; text: string } | null>(null);
  const current = useRef<Session | undefined>(undefined);
  const failed = useRef<Readout | null>(null);
  const synthesisQueue = useRef<Promise<void>>(Promise.resolve());

  function cancel() {
    const session = current.current;
    current.current = undefined;
    if (!session) return;
    session.cancelled = true;
    for (const resume of session.resumes) resume();
    session.release?.();
  }
  useEffect(() => cancel, []);

  function stop() {
    cancel();
    failed.current = null;
    setAudio("off");
    setProgress(null);
  }

  async function read(readout: Readout) {
    cancel();
    failed.current = null;
    const session: Session = { cancelled: false, paused: false, resumes: new Set() };
    current.current = session;
    async function waitForResume() {
      while (session.paused && !session.cancelled) {
        let resume!: () => void;
        await new Promise<void>(resolve => { resume = resolve; session.resumes.add(resolve); });
        session.resumes.delete(resume);
      }
    }
    const load = (part: string) => {
      const request = synthesisQueue.current.then(async () => {
        await waitForResume();
        return session.cancelled ? undefined : companionApi.synthesize(part);
      });
      const settled = request.then(bytes => ({ bytes, error: null }), error => ({ bytes: undefined, error }));
      synthesisQueue.current = settled.then(() => {});
      return settled;
    };
    let index = readout.index;
    try {
      let next = load(readout.parts[index]);
      for (; index < readout.parts.length; index++) {
        setProgress({ index, total: readout.parts.length, text: readout.parts[index] });
        setAudio(session.paused ? "paused" : "preparing");
        const { bytes, error } = await next;
        await waitForResume();
        if (session.cancelled) return;
        if (!bytes) throw error ?? new Error("没有收到浅羽音频。");
        // Generate only the next sentence while the current sentence plays.
        if (index + 1 < readout.parts.length) next = load(readout.parts[index + 1]);
        const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
        const player = new Audio(url);
        session.player = player;
        await new Promise<void>((resolve, reject) => {
          function release() {
            player.onended = null;
            player.onerror = null;
            player.pause();
            player.removeAttribute("src");
            URL.revokeObjectURL(url);
            session.player = undefined;
            session.release = undefined;
          }
          player.onended = () => { release(); resolve(); };
          player.onerror = () => { release(); reject(new Error("无法播放浅羽音频。")); };
          session.release = () => { release(); resolve(); };
          void player.play().then(() => {
            if (session.cancelled || session.player !== player) return;
            if (session.paused) player.pause();
            setAudio(session.paused ? "paused" : "playing");
          }).catch(error => {
            if (session.player === player) { release(); reject(error); }
          });
        });
        if (session.cancelled) return;
      }
    } catch (error) {
      if (!session.cancelled) {
        failed.current = { parts: readout.parts, index };
        onError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (current.current === session) {
        current.current = undefined;
        setAudio(failed.current ? "error" : "off");
        if (!failed.current) setProgress(null);
      }
    }
  }
  function speak(text: string) {
    const parts = asabaSpeechSegments(text);
    if (!parts.length) return Promise.resolve();
    return read({ parts, index: 0 });
  }
  function retry() {
    const readout = failed.current;
    return readout ? read(readout) : Promise.resolve();
  }
  function pause() {
    const session = current.current;
    if (!session || session.cancelled) return;
    session.paused = true;
    session.player?.pause();
    setAudio("paused");
  }
  async function toggle() {
    const session = current.current;
    if (!session || session.cancelled) return;
    if (!session.paused) {
      pause();
      return;
    }
    session.paused = false;
    for (const resume of session.resumes) resume();
    if (session.player) {
      try { await session.player.play(); }
      catch (error) { onError(String(error)); }
    }
    if (current.current === session) setAudio(session.player ? "playing" : "preparing");
  }
  return { audio, progress, speak, stop, pause, toggle, retry };
}

