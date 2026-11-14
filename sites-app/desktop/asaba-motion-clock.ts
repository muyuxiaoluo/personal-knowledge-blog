export type MotionClip = { frames: number; durationMs: number; pages: readonly string[]; procedural?: boolean };
export type MotionFrame = { clip: string | null; frame: number; next: number; mix: number; waiting: boolean; finished: boolean };

export function motionFrameAt(clip: MotionClip, elapsed: number) {
  const position = Math.min(clip.frames - 1, Math.max(0, elapsed) / clip.durationMs * (clip.frames - 1));
  const frame = Math.floor(position);
  return { frame, next: Math.min(clip.frames - 1, frame + 1), mix: position - frame };
}

/** Playback time advances only when the frames needed for that time are decoded. */
export class AsabaMotionClock {
  current: string | null = null;
  pending: string | null = null;
  elapsed = 0;
  private previous: number | null = null;
  private ending = false;
  constructor(readonly clips: Record<string, MotionClip>) {}

  request(clip: string | null) {
    this.pending = clip && clip in this.clips && clip !== this.current ? clip : null;
  }
  pause() { this.previous = null; }
  reset() { this.current = null; this.pending = null; this.elapsed = 0; this.ending = false; this.pause(); }

  step(now: number, ready: (clip: string, frame: number) => boolean): MotionFrame {
    // A long task must not teleport a pose to its end on the next paint.
    let delta = this.previous === null ? 0 : Math.min(50, Math.max(0, now - this.previous));
    this.previous = now;
    if (this.ending) { this.current = null; this.elapsed = 0; this.ending = false; }
    if (!this.current && this.pending) {
      const next = this.pending;
      if (ready(next, 0) && ready(next, 1)) {
        this.current = next; this.pending = null; this.elapsed = 0; delta = 0;
      }
    }
    if (!this.current) return { clip: null, frame: 0, next: 0, mix: 0, waiting: Boolean(this.pending), finished: false };
    const clip = this.clips[this.current];
    const nextTime = Math.min(clip.durationMs, this.elapsed + delta);
    const candidate = nextTime >= clip.durationMs - .001 ? clip.durationMs : nextTime;
    const proposed = motionFrameAt(clip, candidate);
    const waiting = !ready(this.current, proposed.frame) || !ready(this.current, proposed.next);
    if (!waiting) this.elapsed = candidate;
    const frame = motionFrameAt(clip, this.elapsed);
    this.ending = this.elapsed >= clip.durationMs - .001;
    return { clip: this.current, ...frame, waiting, finished: this.ending };
  }
}

export type MotionStats = { hz: number; p95: number; longFrames: number; waiting: number; skipped: number; decodeMs: number; samples: number; seconds: number };
export class MotionMeter {
  private intervals: number[] = [];
  private start = 0;
  private previous = 0;
  private frame: MotionFrame | null = null;
  private waiting = 0;
  private skipped = 0;
  private decodeMs = 0;
  decoded(ms: number) { this.decodeMs = Math.max(this.decodeMs, ms); }
  sample(now: number, frame: MotionFrame) {
    if (!this.start) this.start = now;
    if (this.previous) this.intervals.push(now - this.previous);
    this.previous = now;
    if (frame.clip && frame.waiting) this.waiting++;
    if (frame.clip && frame.clip === this.frame?.clip) this.skipped += Math.max(0, frame.frame - this.frame.frame - 1);
    this.frame = frame;
    // A rolling 2400-interval window keeps diagnostic memory bounded.
    if (this.intervals.length > 2400) this.intervals.shift();
  }
  pause() { this.previous = 0; }
  stats(now: number): MotionStats {
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return { hz: sum ? sorted.length * 1000 / sum : 0, p95: sorted[Math.floor((sorted.length - 1) * .95)] || 0,
      longFrames: sorted.filter(ms => ms > 33.5).length, waiting: this.waiting, skipped: this.skipped,
      decodeMs: this.decodeMs, samples: sorted.length, seconds: this.start ? (now - this.start) / 1000 : 0 };
  }
}
