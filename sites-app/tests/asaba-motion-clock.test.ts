import test from "node:test";
import assert from "node:assert/strict";
import { AsabaMotionClock, motionFrameAt, MotionMeter } from "../desktop/asaba-motion-clock";

const clips = { cheer: { frames: 241, durationMs: 4000, pages: [] }, blink: { frames: 20, durationMs: 1000 * 19 / 60, pages: [] } };
const ready = () => true;
test("playback starts at zero after decoding, regardless of load time", () => {
  const clock = new AsabaMotionClock(clips); clock.request("cheer");
  assert.equal(clock.step(100, () => false).clip, null);
  assert.equal(clock.step(5000, ready).frame, 0);
  assert.equal(clock.step(5000 + 1000 / 60, ready).frame, 1);
});
test("hidden time and delayed texture pages do not skip to the end", () => {
  const clock = new AsabaMotionClock(clips); clock.request("cheer"); clock.step(0, ready);
  const held = clock.step(17, () => false);
  assert.equal(held.frame, 0); assert.equal(held.waiting, true);
  clock.pause();
  assert.equal(clock.step(60_000, ready).frame, 0);
  assert.equal(clock.step(60_017, ready).frame, 1);
});
test("a pose renders its neutral last frame before the latest queued action starts", () => {
  const clock = new AsabaMotionClock(clips); clock.request("blink"); clock.step(0, ready);
  clock.request("cheer");
  let final = clock.step(17, ready);
  for (let time = 34; time <= 340 && !final.finished; time += 17) final = clock.step(time, ready);
  assert.equal(final.finished, true); assert.equal(final.frame, 19);
  const next = clock.step(357, ready);
  assert.equal(next.clip, "cheer"); assert.equal(next.frame, 0);
});
test("repeat requests do not restart playback, and idle cancels stale queued poses", () => {
  const clock = new AsabaMotionClock(clips); clock.request("cheer"); clock.step(0, ready);
  clock.step(17, ready); clock.request("cheer");
  assert.equal(clock.step(34, ready).frame, 2);
  clock.request("blink"); clock.request(null); assert.equal(clock.pending, null);
  clock.reset(); assert.equal(clock.current, null); assert.equal(clock.elapsed, 0);
});
test("a 120 Hz display gets intermediate blends between uniformly spaced 60 Hz poses", () => {
  const f = motionFrameAt(clips.cheer, 1000 / 120);
  assert.equal(f.frame, 0); assert.equal(f.next, 1); assert.ok(Math.abs(f.mix - .5) < .001);
  assert.deepEqual(motionFrameAt(clips.cheer, 9000), { frame: 240, next: 240, mix: 0 });
});
test("frame pacing reports observed cadence rather than a configured FPS label", () => {
  const meter = new MotionMeter();
  for (let i = 0; i < 121; i++) meter.sample(100 + i * 1000 / 120, { clip: null, frame: 0, next: 0, mix: 0, waiting: false, finished: false });
  const stats = meter.stats(1100);
  assert.ok(Math.abs(stats.hz - 120) < .001); assert.equal(stats.longFrames, 0); assert.equal(stats.waiting, 0);
});
