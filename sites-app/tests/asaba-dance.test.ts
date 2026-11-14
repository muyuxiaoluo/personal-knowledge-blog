import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { asabaDancePose } from "../desktop/asaba-dance";
import { AsabaMotionClock } from "../desktop/asaba-motion-clock";

test("dance keeps the original head rigid rather than changing its proportions", () => {
  const width = 96, height = 114;
  for (let frame = 0; frame <= 252; frame++) {
    const pose = asabaDancePose(frame / 252);
    for (const [cos, sin] of [pose.body, pose.head]) {
      assert.ok(Math.abs(cos * cos + sin * sin - 1) < 1e-12);
      assert.ok(Math.abs(Math.hypot(width * cos, width * sin) - width) < 1e-10);
      assert.ok(Math.abs(Math.hypot(-height * sin, height * cos) - height) < 1e-10);
    }
  }
});
test("steps alternate support feet, stay within the pet footprint and settle exactly", () => {
  const rest = asabaDancePose();
  assert.deepEqual(asabaDancePose(0), rest); assert.deepEqual(asabaDancePose(1), rest);
  let left = false, right = false;
  for (let frame = 1; frame < 252; frame++) {
    const pose = asabaDancePose(frame / 252);
    const [lx, ly, rx, ry] = pose.steps;
    assert.ok(ly === 0 || ry === 0, "one foot remains planted");
    assert.ok(Math.abs(lx) <= 2.2 && Math.abs(rx) <= 2.2 && ly >= -4 && ry >= -4);
    assert.ok(Math.abs(pose.body[2]) <= 5 && Math.abs(pose.body[3]) <= 1.4);
    left ||= ly < -1; right ||= ry < -1;
  }
  assert.ok(left && right);
});
test("the native spin cue uses only the unchanged portrait and a timed dance", () => {
  const catalogue = JSON.parse(readFileSync(new URL("../desktop/asaba-motion/manifest.json", import.meta.url), "utf8"));
  const dance = catalogue.clips.spin;
  assert.equal(dance.procedural, true);
  assert.deepEqual(dance.pages, [catalogue.neutral]); assert.equal(dance.frames, 1); assert.equal(dance.durationMs, 4200);
  const clock = new AsabaMotionClock(catalogue.clips); clock.request("spin");
  let last = clock.step(0, () => true);
  for (let now = 1000 / 60; now <= 4250 && !last.finished; now += 1000 / 60) {
    last = clock.step(now, () => true); assert.equal(last.frame, 0); assert.equal(last.next, 0);
  }
  assert.equal(last.finished, true); assert.deepEqual(asabaDancePose(clock.elapsed / dance.durationMs), asabaDancePose());
});
