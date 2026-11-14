import assert from "node:assert/strict";
import test from "node:test";
import { AsabaPetActivation } from "../desktop/asaba-pet-activation";

test("a double/triple click opens once, including click counts reset by native resize", () => {
  for (const details of [[1, 2, 3], [1, 1, 1]]) {
    const activation = new AsabaPetActivation();
    let expanded = false, transitions = 0;
    details.forEach((detail, index) => {
      if (!activation.begin(detail, 1000 + index * 150)) return;
      expanded = !expanded; transitions++;
      activation.finish();
    });
    assert.equal(expanded, true); assert.equal(transitions, 1);
    assert.equal(activation.begin(1, 1700), true, "a later deliberate click can close");
  }
});

test("pending native transitions suppress repeats, and completing one restores interaction", () => {
  const activation = new AsabaPetActivation();
  assert.equal(activation.begin(1, 0), true);
  assert.equal(activation.begin(1, 1500), false, "still waiting for native response");
  activation.finish();
  assert.equal(activation.begin(1, 1501), true);
  activation.finish();
  assert.equal(activation.begin(1, 1600), false, "completion doesn't discard burst protection");
  assert.equal(activation.begin(1, 2200), true);
});

test("slow double clicks and keyboard activation keep one transition per gesture", () => {
  const activation = new AsabaPetActivation();
  assert.equal(activation.begin(1, 0), true); activation.finish();
  assert.equal(activation.begin(2, 800), false, "native multi-click remains grouped beyond the guard interval");
  assert.equal(activation.begin(0, 1000), true); activation.finish();
  assert.equal(activation.begin(0, 1050), false, "key repeat can't oscillate the window");
  assert.equal(activation.begin(0, 1800), true);
});
