import assert from "node:assert/strict";
import test from "node:test";
import { toggleMarkdownHeading } from "../app/markdown-heading";

test("turns a plain line into a heading and keeps the caret with its text", () => {
  assert.deepEqual(toggleMarkdownHeading("开头\n标题文字\n结尾", { start: 5, end: 5 }, 1), {
    body: "开头\n# 标题文字\n结尾",
    selection: { start: 7, end: 7 },
  });
});

test("clicking the same heading again restores a normal paragraph", () => {
  assert.deepEqual(toggleMarkdownHeading("开头\n# 标题文字\n结尾", { start: 7, end: 7 }, 1), {
    body: "开头\n标题文字\n结尾",
    selection: { start: 5, end: 5 },
  });
});

test("switches an existing heading to the requested level", () => {
  assert.deepEqual(toggleMarkdownHeading("## 标题文字", { start: 3, end: 7 }, 1), {
    body: "# 标题文字",
    selection: { start: 2, end: 6 },
  });
});

test("toggles all selected lines without touching surrounding content", () => {
  const heading = toggleMarkdownHeading("之前\n第一行\n第二行\n之后", { start: 3, end: 10 }, 2);
  assert.deepEqual(heading, {
    body: "之前\n## 第一行\n## 第二行\n之后",
    selection: { start: 6, end: 16 },
  });
  assert.deepEqual(toggleMarkdownHeading(heading.body, heading.selection, 2), {
    body: "之前\n第一行\n第二行\n之后",
    selection: { start: 3, end: 10 },
  });
});
