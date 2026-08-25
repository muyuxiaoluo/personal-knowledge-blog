import assert from "node:assert/strict";
import test from "node:test";
import {
  appendCaptureRelation,
  buildCapturedArticle,
  captureMetadata,
  captureOriginId,
  captureRelations,
  findExistingCapturedSource,
  formatPlaybackTime,
  preserveCaptureSourceMetadata,
  sourceForCapturedResult,
  type EntertainmentCaptureSnapshot,
} from "../app/entertainment-capture";
import type { StoredArticle } from "../app/types";

const snapshot: EntertainmentCaptureSnapshot = {
  requestId: "capture-1",
  provider: "bilibili",
  canonicalUrl: "https://www.bilibili.com/video/BV1example?p=2",
  contentId: "BV1example",
  title: "深度学习基础课程",
  author: "课程作者",
  description: "从神经网络开始学习。",
  thumbnailUrl: "https://i.example.com/cover.png",
  playbackSeconds: 125,
  selectedText: "值得记录的一句话",
  capturedAt: "2026-08-24T10:30:00+08:00",
};

test("builds a sync-compatible Explore article with typed capture metadata", () => {
  const article = buildCapturedArticle({ mode: "explore", snapshot });
  assert.equal(article.collection, "sources");
  assert.equal(article.branch, "收藏中");
  assert.equal(article.source[0], "哔哩哔哩");
  assert.equal(article.source[1], snapshot.canonicalUrl);
  assert.equal(captureMetadata(article)?.playbackSeconds, 125);
  assert.match(article.body, /视频时间：2:05/);
  assert.equal(formatPlaybackTime(3_665), "1:01:05");
});

test("builds a thought inbox item and keeps quote and source time", () => {
  const article = buildCapturedArticle({
    mode: "thought",
    snapshot,
    thought: "这里的讲解方式可以用于之后的课程笔记。",
    quote: "先理解结构，再记住公式。",
  });
  assert.equal(article.collection, "notes");
  assert.equal(article.branch, "待分类");
  assert.match(article.body, /> 先理解结构，再记住公式。/);
  assert.match(article.body, /视频时间：2:05/);
});

test("deduplicates the same canonical content but keeps Bilibili parts distinct", () => {
  const article = buildCapturedArticle({ mode: "explore", snapshot }) as StoredArticle;
  article.storage = { version: 1, deviceId: "test", syncStatus: "pending", deletedAt: null };
  assert.equal(findExistingCapturedSource([article], snapshot)?.title, article.title);
  assert.equal(findExistingCapturedSource([article], { ...snapshot, canonicalUrl: "https://www.bilibili.com/video/BV1example?p=3" }), undefined);
});

test("preserves hidden capture metadata and records organization relations", () => {
  const article = buildCapturedArticle({ mode: "explore", snapshot });
  const editedSource = preserveCaptureSourceMetadata(article.source, "视频", snapshot.canonicalUrl);
  assert.equal(captureMetadata({ source: editedSource })?.contentId, "BV1example");

  const organized = appendCaptureRelation(article, { kind: "task", id: "task:1" });
  assert.equal(organized.stage, "已整理");
  assert.deepEqual(captureRelations(organized), [{ kind: "task", id: "task:1" }]);

  const targetSource = sourceForCapturedResult(organized.source, "sources/course");
  assert.equal(captureOriginId({ source: targetSource }), "sources/course");
  assert.deepEqual(captureRelations({ source: targetSource }), []);
});
