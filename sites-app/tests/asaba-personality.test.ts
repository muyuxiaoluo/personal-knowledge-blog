import assert from "node:assert/strict";
import test from "node:test";
import { asabaMaySpeak, asabaMoment, asabaPlayKind } from "../desktop/asaba-personality";

const ready = { automatic: true, enabled: true, quiet: false, visible: true, now: 120_000, lastAt: 0 };
test("ambient chatter waits two minutes and stays quiet while focusing, hidden or disabled", () => {
  assert.equal(asabaMaySpeak(ready), true);
  assert.equal(asabaMaySpeak({ ...ready, now: 119_999 }), false);
  assert.equal(asabaMaySpeak({ ...ready, quiet: true }), false);
  assert.equal(asabaMaySpeak({ ...ready, visible: false }), false);
  assert.equal(asabaMaySpeak({ ...ready, enabled: false }), false);
});
test("an explicit interaction remains available while ambient chatter is quiet", () => {
  assert.equal(asabaMaySpeak({ ...ready, automatic: false, enabled: false, quiet: true, now: 1 }), true);
  assert.equal(asabaMaySpeak({ ...ready, automatic: false, visible: false }), false);
});
test("play interactions vary and late-night flavor follows the local clock", () => {
  const day = Array.from({ length: 5 }, (_, i) => asabaPlayKind(i, 12));
  assert.equal(new Set(day).size, 5);
  assert.equal(asabaPlayKind(1, 23), "sleepy");
  assert.equal(asabaPlayKind(1, 2), "sleepy");
  assert.equal(asabaPlayKind(6, 2), "sleepy");
  assert.notEqual(asabaMoment("pat", 0).text, asabaMoment("pat", 1).text);
  assert.equal(asabaMoment("pat", 2).text, asabaMoment("pat", 0).text);
});
