import assert from "node:assert/strict";
import test from "node:test";
import { inferNoteCategory } from "../app/note-taxonomy";

test("keeps an explicitly selected new note category", () => {
  assert.equal(inferNoteCategory({ category: "journal", type: "复盘", title: "一次经历" }), "journal");
  assert.equal(inferNoteCategory({ category: "uncategorized", type: "想法", title: "一个想法" }), "uncategorized");
});

test("maps legacy note categories and fixed natures without rewriting data", () => {
  assert.equal(inferNoteCategory({ category: "思考随笔", type: "记录" }), "reflection");
  assert.equal(inferNoteCategory({ category: "复盘日志", type: "记录" }), "review");
  assert.equal(inferNoteCategory({ category: "生活", type: "知识" }), "learning");
  assert.equal(inferNoteCategory({ category: "模板库", type: "模板" }), "quick-note");
});

test("uses restrained keyword inference only when legacy metadata has no answer", () => {
  assert.equal(inferNoteCategory({ title: "一次难忘的旅行经历" }), "journal");
  assert.equal(inferNoteCategory({ title: "课程论文知识整理" }), "learning");
  assert.equal(inferNoteCategory({ title: "普通记录" }), "uncategorized");
});
