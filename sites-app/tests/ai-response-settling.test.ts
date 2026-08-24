import assert from "node:assert/strict";
import test from "node:test";
import {
  FALLBACK_GENERATION_STABILITY_MS,
  OBSERVED_GENERATION_STABILITY_MS,
  isAiResponseSettled,
  isMoreCompleteAiAnswer,
  shouldConfirmAiConversationDeletion,
} from "../app/ai-response-settling";

test("does not save a partial answer when the website generation button is not recognized", () => {
  assert.equal(isAiResponseSettled({
    generating: false,
    changed: true,
    hasGenerated: true,
    observedGenerating: false,
    stableForMs: FALLBACK_GENERATION_STABILITY_MS - 1,
  }), false);
  assert.equal(isAiResponseSettled({
    generating: false,
    changed: true,
    hasGenerated: true,
    observedGenerating: false,
    stableForMs: FALLBACK_GENERATION_STABILITY_MS,
  }), true);
});

test("saves sooner after a real generating-to-ready transition", () => {
  assert.equal(isAiResponseSettled({
    generating: false,
    changed: true,
    hasGenerated: true,
    observedGenerating: true,
    stableForMs: OBSERVED_GENERATION_STABILITY_MS - 1,
  }), false);
  assert.equal(isAiResponseSettled({
    generating: false,
    changed: true,
    hasGenerated: true,
    observedGenerating: true,
    stableForMs: OBSERVED_GENERATION_STABILITY_MS,
  }), true);
  assert.equal(isAiResponseSettled({
    generating: true,
    changed: true,
    hasGenerated: true,
    observedGenerating: true,
    stableForMs: 60_000,
  }), false);
});

test("recognizes a Markdown-formatted official answer as the richer copy", () => {
  const plain = "第一层：固定起床时间\n策略：每天七点起床\n最后提醒";
  const markdown = "### 第一层：固定起床时间\n\n- &#8203;**策略：**&#8203; 每天七点起床\n\n---\n\n最后提醒";
  assert.equal(isMoreCompleteAiAnswer(plain, markdown), true);
  assert.equal(isMoreCompleteAiAnswer(markdown, markdown), false);
});

test("only conversations containing messages require deletion confirmation", () => {
  assert.equal(shouldConfirmAiConversationDeletion(0), false);
  assert.equal(shouldConfirmAiConversationDeletion(1), true);
});
