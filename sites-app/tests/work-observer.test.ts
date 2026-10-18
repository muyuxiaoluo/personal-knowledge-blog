import assert from "node:assert/strict";
import test from "node:test";
import { observationSessions, observerEvidenceLabel, observerScreenLabel, type WorkObservation } from "../app/work-observer-types";

function observation(id: string, sessionId: string, capturedAt: string): WorkObservation {
  return { id, sessionId, capturedAt, taskId: null, taskLabel: "", trigger: "manual", windowTitle: "编辑器", application: "editor.exe", screenshot: true, fileChanges: [{ path: "D:\\paper\\methods.tex", kind: "modified", before: "旧段落", after: "新段落", excerptLimited: false }], notes: [], analysis: null, analysisError: null, model: "local", elapsedMs: 0 };
}
test("work fragments stay separated even when they share an action", () => {
  const records = [observation("1", "a", "2026-10-03T10:00:00Z"), observation("2", "b", "2026-10-03T12:00:00Z"), observation("3", "a", "2026-10-03T11:00:00Z")];
  const sessions = observationSessions(records);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[0].records.map((record) => record.id), ["3", "1"]);
  assert.deepEqual(records.map((record) => record.id), ["1", "2", "3"]);
});

test("prior evidence resolves within the saved context instead of another record or guessed path", () => {
  const record = observation("2", "a", "2026-10-03T10:02:00Z");
  record.context = [{ id: "1", capturedAt: "2026-10-03T10:00:00Z", windowTitle: "编辑器", application: "editor.exe", omittedFiles: 0, files: [{ evidenceId: "previous:1:file:0", path: "D:\\paper\\methods.tex", kind: "modified", after: "引用尚未校对", excerptLimited: false }] }];
  assert.equal(observerEvidenceLabel("previous:1:file:0", record), "较早采样 · methods.tex");
  assert.equal(observerEvidenceLabel("previous:other:file:0", record), "来源不可用");
  assert.match(observerScreenLabel("chat"), /不代表已执行/);
  assert.match(observerScreenLabel("terminal"), /未核验运行结果/);
});
test("model source references can only display existing captured evidence", () => {
  const record = observation("1", "a", "2026-10-03T10:00:00Z");
  assert.equal(observerEvidenceLabel("file:0", record), "methods.tex");
  assert.equal(observerEvidenceLabel("file:999", record), "来源不可用");
  assert.equal(observerEvidenceLabel("screen", { ...record, screenshot: false }), "来源不可用");
});
