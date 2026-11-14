import { AsabaMotionClock, MotionMeter, motionFrameAt, type MotionClip, type MotionFrame, type MotionStats } from "./asaba-motion-clock";
import { asabaDancePose } from "./asaba-dance";

export type MotionCatalogue = { width: number; height: number; columns: number; rows: number; pageFrames: number; neutral: string; clips: Record<string, MotionClip> };
type Page = { texture?: WebGLTexture; abort: AbortController; failed?: boolean };
type Options = { url: (name: string) => string; pointer: () => { x: number; y: number }; ready: (ready: boolean) => void;
  stats: (stats: MotionStats & { clip: string; pages: number; error: string }) => void };

const vertex = `
attribute vec2 aUv;
varying vec2 vUv;
uniform vec2 uFit, uGaze;
uniform float uTime, uMotion;
uniform vec4 uDanceBody, uDanceHands, uDanceSteps;
uniform vec2 uDanceHead, uDanceSkirt;
void main() {
  vec2 p = aUv;
  float head = 1.0 - smoothstep(.38, .65, p.y);
  float planted = 1.0 - smoothstep(.66, .96, p.y);
  float hair = smoothstep(.16, .39, abs(p.x-.5)) * smoothstep(.10,.23,p.y) * (1.0-smoothstep(.65,.84,p.y));
  float angle = uGaze.x * .023 * uMotion;
  vec2 q = p - vec2(.5,.38);
  p += (mat2(cos(angle),sin(angle),-sin(angle),cos(angle))*q-q) * head;
  p.x += (uGaze.x * 1.4 * head + sin(uTime*1.25+p.y*5.0)*.65*hair) / 256.0 * uMotion;
  p.y += (uGaze.y * .9 * head + sin(uTime*1.31)*.75*planted) / 320.0 * uMotion;
  vec2 pixels = p * vec2(256.0,320.0);
  // The entire face uses rigid pixel-space rotations, never a scale or a
  // replacement portrait. Falloffs lie below the chin and at the knees.
  vec2 neck = vec2(128.0,172.0);
  mat2 headRotation = mat2(uDanceHead.x,uDanceHead.y,-uDanceHead.y,uDanceHead.x);
  pixels += (headRotation*(pixels-neck)+neck-pixels) * (1.0-smoothstep(.53,.63,aUv.y));
  vec2 hip = vec2(128.0,234.0);
  mat2 bodyRotation = mat2(uDanceBody.x,uDanceBody.y,-uDanceBody.y,uDanceBody.x);
  pixels += (bodyRotation*(pixels-hip)+hip-pixels+uDanceBody.zw) * (1.0-smoothstep(.65,.96,aUv.y));
  float arms = smoothstep(.54,.57,aUv.y) * (1.0-smoothstep(.67,.73,aUv.y));
  vec2 l = (aUv-vec2(.41,.61))/vec2(.10,.085);
  vec2 r = (aUv-vec2(.58,.61))/vec2(.10,.085);
  pixels += (uDanceHands.xy*exp(-dot(l,l)*2.0)+uDanceHands.zw*exp(-dot(r,r)*2.0))*arms;
  float feet = smoothstep(.75,.89,aUv.y);
  float rightFoot = smoothstep(.48,.52,aUv.x);
  pixels += mix(uDanceSteps.xy,uDanceSteps.zw,rightFoot)*feet;
  float skirt = smoothstep(.63,.69,aUv.y)*(1.0-smoothstep(.83,.89,aUv.y))*smoothstep(.09,.31,abs(aUv.x-.5));
  pixels += uDanceSkirt*skirt;
  p = pixels/vec2(256.0,320.0);
  gl_Position = vec4((p.x-.5)*uFit.x, (.5-p.y)*uFit.y, 0.0, 1.0);
  vUv = aUv;
}`;
const fragment = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uFirst, uSecond;
uniform vec4 uRectA, uRectB;
uniform float uMix;
void main() {
  vec4 a = texture2D(uFirst, uRectA.xy + vUv*uRectA.zw);
  vec4 b = texture2D(uSecond, uRectB.xy + vUv*uRectB.zw);
  gl_FragColor = mix(a,b,uMix);
}`;

/** One rAF clock, one GPU mesh draw. Only current/next small pages are decoded. */
export class AsabaMotionRenderer {
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private buffer: WebGLBuffer;
  private uniforms = new Map<string, WebGLUniformLocation>();
  private textures = new Map<string, Page>();
  private raf = 0;
  private disposed = false;
  private enabled = true;
  private probe = false;
  private probeIndex = 0;
  private meter = new MotionMeter();
  private lastStats = 0;
  private previous = 0;
  private time = 0;
  private blinkAt = 0;
  private gaze = { x: 0, y: 0 };
  private cssWidth = 116;
  private cssHeight = 139;
  private observer: ResizeObserver;
  private error = "";
  private clock: AsabaMotionClock;
  private state = "idle";

  constructor(private canvas: HTMLCanvasElement, private catalogue: MotionCatalogue, private options: Options) {
    const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) throw new Error("人物绘制未能启用");
    this.gl = gl;
    this.clock = new AsabaMotionClock(catalogue.clips);
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!; gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || "绘制程序未能编译");
      return shader;
    };
    this.program = gl.createProgram()!;
    const vs = compile(gl.VERTEX_SHADER, vertex), fs = compile(gl.FRAGMENT_SHADER, fragment);
    gl.attachShader(this.program, vs); gl.attachShader(this.program, fs); gl.linkProgram(this.program);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error("人物绘制程序未能连接");
    const vertices: number[] = [];
    for (let y = 0; y < 24; y++) for (let x = 0; x < 12; x++) {
      const a = x / 12, b = y / 24, c = (x + 1) / 12, d = (y + 1) / 24;
      vertices.push(a,b,c,b,a,d,c,b,c,d,a,d);
    }
    this.buffer = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    this.observer = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect;
      if (box) { this.cssWidth = box.width; this.cssHeight = box.height; this.paint(); }
    });
    this.observer.observe(canvas);
    document.addEventListener("visibilitychange", this.visibility);
    canvas.addEventListener("webglcontextlost", this.lost);
    this.prepare(); this.wake();
  }
  setState(state: string) {
    this.state = state;
    if (this.probe) return;
    const action = state === "patted" || state === "excited" ? "cheer" : state === "curious" ? "thinking" : state;
    this.clock.request(action in this.catalogue.clips ? action : null);
    this.prepare(); this.wake();
  }
  setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled; this.clock.reset(); this.previous = 0;
    if (enabled) this.setState(this.state);
    this.prepare(); this.paint(); this.wake();
  }
  setProbe(probe: boolean) {
    this.probe = probe; this.meter = new MotionMeter(); this.lastStats = 0; this.clock.reset(); this.probeIndex = 0;
    if (probe) this.clock.request(Object.keys(this.catalogue.clips)[0]);
    else this.setState(this.state);
    this.prepare(); this.wake();
  }
  private visibility = () => {
    this.clock.pause(); this.previous = 0; this.meter.pause();
    if (document.hidden) { cancelAnimationFrame(this.raf); this.raf = 0; }
    else this.wake();
  };
  private lost = (event: Event) => {
    event.preventDefault(); this.error = "绘制上下文中断"; this.options.ready(false); this.dispose();
  };
  private wake() {
    if (!this.raf && !this.disposed && !document.hidden) this.raf = requestAnimationFrame(this.tick);
  }
  private page(clip: string, frame: number) {
    return this.catalogue.clips[clip].pages[Math.floor(frame / this.catalogue.pageFrames)];
  }
  private prepare() {
    const wanted = new Set([this.catalogue.neutral]);
    if (this.enabled && this.clock.current) {
      const clip = this.catalogue.clips[this.clock.current];
      const frame = motionFrameAt(clip, this.clock.elapsed).frame;
      const page = Math.floor(frame / this.catalogue.pageFrames);
      wanted.add(clip.pages[page]);
      if (clip.pages[page + 1]) wanted.add(clip.pages[page + 1]);
    }
    if (this.enabled && this.clock.pending) wanted.add(this.page(this.clock.pending, 0));
    for (const name of wanted) this.load(name);
    for (const [name, entry] of this.textures) if (!wanted.has(name)) {
      entry.abort.abort(); if (entry.texture) this.gl.deleteTexture(entry.texture); this.textures.delete(name);
    }
  }
  private load(name: string) {
    if (this.textures.has(name)) return;
    const entry: Page = { abort: new AbortController() }; this.textures.set(name, entry);
    void fetch(this.options.url(name), { signal: entry.abort.signal }).then(async response => {
      if (!response.ok) throw new Error(`人物画面加载失败 ${response.status}`);
      const blob = await response.blob(), start = performance.now();
      const bitmap = await createImageBitmap(blob, { premultiplyAlpha: "premultiply", colorSpaceConversion: "none" });
      if (this.disposed || this.textures.get(name) !== entry) { bitmap.close(); return; }
      const gl = this.gl; entry.texture = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      bitmap.close(); this.meter.decoded(performance.now() - start); this.wake();
    }).catch(error => {
      if (entry.abort.signal.aborted || this.disposed) return;
      entry.failed = true; this.error = error instanceof Error ? error.message : String(error); this.clock.reset(); this.wake();
    });
  }
  private uniform(name: string) {
    let location = this.uniforms.get(name);
    if (!location) { location = this.gl.getUniformLocation(this.program, name)!; this.uniforms.set(name, location); }
    return location;
  }
  private frame: MotionFrame = { clip: null, frame: 0, next: 0, mix: 0, waiting: false, finished: false };
  private tick = (now: number) => {
    this.raf = 0;
    if (this.disposed || document.hidden) return;
    const elapsed = this.previous ? Math.min(50, now - this.previous) : 0; this.previous = now;
    if (this.enabled) {
      this.time += elapsed / 1000;
      const pointer = this.options.pointer(), amount = 1 - Math.exp(-elapsed / 95);
      this.gaze.x += (pointer.x - this.gaze.x) * amount; this.gaze.y += (pointer.y - this.gaze.y) * amount;
      if (!this.clock.current && !this.clock.pending && !this.probe && now >= this.blinkAt) { this.clock.request("blink"); this.blinkAt = now + 5300; }
      this.prepare();
      this.frame = this.clock.step(now, (clip, frame) => Boolean(this.textures.get(this.page(clip, frame))?.texture));
      if (this.frame.finished) {
        this.blinkAt = now + 5300;
        if (this.probe) { const clips = Object.keys(this.catalogue.clips); this.clock.request(clips[++this.probeIndex % clips.length]); }
      }
    } else this.frame = { clip: null, frame: 0, next: 0, mix: 0, waiting: false, finished: false };
    this.paint();
    if (this.probe) {
      this.meter.sample(now, this.frame);
      if (now - this.lastStats > 1000) {
        this.lastStats = now;
        this.options.stats({ ...this.meter.stats(now), clip: this.frame.clip || "idle", pages: this.textures.size, error: this.error });
      }
    }
    if (this.enabled) this.wake();
  };
  private paint() {
    if (this.disposed) return;
    const gl = this.gl, neutral = this.textures.get(this.catalogue.neutral)?.texture;
    if (!neutral) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(this.cssWidth * ratio)), height = Math.max(1, Math.round(this.cssHeight * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    gl.viewport(0, 0, width, height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const attribute = gl.getAttribLocation(this.program, "aUv"); gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
    const bind = (frame: number, unit: number, sampler: string, rect: string) => {
      const name = this.frame.clip ? this.page(this.frame.clip, frame) : this.catalogue.neutral;
      const texture = this.textures.get(name)?.texture || neutral;
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture); gl.uniform1i(this.uniform(sampler), unit);
      if (texture === neutral) gl.uniform4f(this.uniform(rect), .5 / 256, .5 / 320, 255 / 256, 319 / 320);
      else {
        const cell = frame % this.catalogue.pageFrames;
        gl.uniform4f(this.uniform(rect), (cell % this.catalogue.columns * 256 + .5) / (256 * this.catalogue.columns),
          (Math.floor(cell / this.catalogue.columns) * 320 + .5) / (320 * this.catalogue.rows), 255 / (256 * this.catalogue.columns), 319 / (320 * this.catalogue.rows));
      }
    };
    bind(this.frame.frame, 0, "uFirst", "uRectA"); bind(this.frame.next, 1, "uSecond", "uRectB");
    const fit = Math.min(this.cssWidth / 256, this.cssHeight / 320);
    gl.uniform2f(this.uniform("uFit"), fit * 512 / this.cssWidth, fit * 640 / this.cssHeight);
    gl.uniform2f(this.uniform("uGaze"), this.gaze.x, this.gaze.y);
    const clip = this.frame.clip ? this.catalogue.clips[this.frame.clip] : null;
    const dancing = this.enabled && Boolean(clip?.procedural);
    const dance = asabaDancePose(dancing ? this.clock.elapsed / clip!.durationMs : undefined);
    gl.uniform4f(this.uniform("uDanceBody"), ...dance.body);
    gl.uniform2f(this.uniform("uDanceHead"), ...dance.head);
    gl.uniform4f(this.uniform("uDanceHands"), ...dance.hands);
    gl.uniform4f(this.uniform("uDanceSteps"), ...dance.steps);
    gl.uniform2f(this.uniform("uDanceSkirt"), ...dance.skirt);
    gl.uniform1f(this.uniform("uTime"), this.time); gl.uniform1f(this.uniform("uMotion"), this.enabled && !dancing ? (this.frame.clip ? .2 : 1) : 0);
    gl.uniform1f(this.uniform("uMix"), this.frame.mix);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.drawArrays(gl.TRIANGLES, 0, 12 * 24 * 6);
    this.options.ready(true);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; cancelAnimationFrame(this.raf); this.raf = 0; this.observer.disconnect();
    document.removeEventListener("visibilitychange", this.visibility); this.canvas.removeEventListener("webglcontextlost", this.lost);
    for (const entry of this.textures.values()) { entry.abort.abort(); if (entry.texture) this.gl.deleteTexture(entry.texture); }
    this.textures.clear(); this.gl.deleteBuffer(this.buffer); this.gl.deleteProgram(this.program);
  }
}
