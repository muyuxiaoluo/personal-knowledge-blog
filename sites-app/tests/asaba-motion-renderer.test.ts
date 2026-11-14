import test from "node:test";
import assert from "node:assert/strict";
import { AsabaMotionRenderer } from "../desktop/asaba-motion-renderer";

function environment() {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const set = (name: string, value: unknown) => { saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
  let sequence = 0, draws = 0, deleted = 0, closed = 0, motion = 0;
  const fetched: string[] = [];
  let danceBody: number[] = [];
  let rect: number[] = [];
  const frames = new Map<number, FrameRequestCallback>();
  const document = Object.assign(new EventTarget(), { hidden: false });
  const gl = new Proxy({}, { get: (_target, name) => {
    if (name === "getShaderParameter" || name === "getProgramParameter") return () => true;
    if (name === "getUniformLocation") return (_program: unknown, key: string) => key;
    if (name === "getAttribLocation") return () => 0;
    if (String(name).startsWith("create")) return () => ({});
    if (name === "drawArrays") return () => { draws++; };
    if (name === "deleteTexture") return () => { deleted++; };
    if (name === "uniform1f") return (key: string, value: number) => { if (key === "uMotion") motion = value; };
    if (name === "uniform4f") return (key: string, ...value: number[]) => { if (key === "uRectA") rect = value; if (key === "uDanceBody") danceBody = value; };
    return /^[A-Z_0-9]+$/.test(String(name)) ? 1 : () => {};
  } });
  const canvas = Object.assign(new EventTarget(), { width: 0, height: 0, getContext: () => gl }) as unknown as HTMLCanvasElement;
  set("window", { devicePixelRatio: 1 }); set("document", document);
  set("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  set("cancelAnimationFrame", (id: number) => frames.delete(id));
  set("ResizeObserver", class { observe() {} disconnect() {} });
  set("fetch", async (name: string) => { fetched.push(name); return { ok: true, blob: async () => new Blob() }; });
  set("createImageBitmap", async () => ({ close: () => { closed++; } }));
  const catalogue = { width: 256, height: 320, columns: 6, rows: 4, pageFrames: 24, neutral: "neutral",
    clips: { cuddle: { frames: 241, durationMs: 4000, pages: Array.from({ length: 11 }, (_, i) => "cuddle-" + i) }, blink: { frames: 20, durationMs: 320, pages: ["blink"] },
      spin: { frames: 1, durationMs: 4200, pages: ["neutral"], procedural: true } } };
  const renderer = (ready: (value: boolean) => void = () => {}) => new AsabaMotionRenderer(canvas, catalogue,
    { url: name => name, pointer: () => ({ x: 0, y: 0 }), ready, stats: () => {} });
  return {
    document, renderer,
    pump(time: number) { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(time); },
    async settle() { await new Promise(resolve => setImmediate(resolve)); },
    get draws() { return draws; }, get deleted() { return deleted; }, get closed() { return closed; },
    get motion() { return motion; }, get rect() { return rect; }, get scheduled() { return frames.size; },
    get fetched() { return fetched; }, get danceBody() { return danceBody; },
    restore() { for (const [name, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } },
  };
}

test("disabling motion stops continuous paints, releases action pages and can resume", async () => {
  const env = environment(); const renderer = env.renderer();
  try {
    renderer.setState("cuddle"); await env.settle(); env.pump(100); await env.settle(); env.pump(117);
    assert.ok(env.draws > 0); assert.equal(env.motion, .2);
    renderer.setEnabled(false); env.pump(134);
    const stopped = env.draws;
    env.pump(1000); assert.equal(env.draws, stopped); assert.equal(env.scheduled, 0); assert.equal(env.motion, 0);
    assert.ok(env.deleted >= 1);
    renderer.setEnabled(true); await env.settle(); env.pump(1100);
    assert.ok(env.draws > stopped); assert.ok(env.scheduled > 0);
  } finally { renderer.dispose(); env.restore(); }
});

test("dance draws only the original portrait, and disabling it restores the exact rest transform", async () => {
  const env = environment(); const renderer = env.renderer();
  try {
    renderer.setState("spin"); await env.settle(); env.pump(100);
    for (let now = 117; now < 1200; now += 17) env.pump(now);
    assert.deepEqual(env.fetched, ["neutral"]);
    assert.notDeepEqual(env.danceBody, [1, 0, 0, 0]);
    assert.ok(Math.abs(env.danceBody[0] ** 2 + env.danceBody[1] ** 2 - 1) < 1e-12);
    renderer.setEnabled(false); env.pump(1217);
    assert.deepEqual(env.danceBody, [1, 0, 0, 0]); assert.equal(env.scheduled, 0);
  } finally { renderer.dispose(); env.restore(); }
});

test("hidden time preserves the current pose and disposal prevents stale callbacks", async () => {
  const env = environment(); let oldReady = 0;
  const renderer = env.renderer(() => { oldReady++; });
  try {
    renderer.setState("cuddle"); await env.settle(); env.pump(100); await env.settle(); env.pump(140);
    const rect = env.rect;
    env.document.hidden = true; env.document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(env.scheduled, 0);
    env.document.hidden = false; env.document.dispatchEvent(new Event("visibilitychange")); env.pump(60_000);
    assert.deepEqual(env.rect, rect);
    renderer.dispose(); const before = oldReady;
    await env.settle(); env.pump(60_017); assert.equal(oldReady, before); assert.equal(env.scheduled, 0);
    assert.ok(env.closed > 0); assert.ok(env.deleted > 0);
  } finally { renderer.dispose(); env.restore(); }
});
