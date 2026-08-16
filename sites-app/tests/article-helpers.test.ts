import assert from "node:assert/strict";
import test from "node:test";
import { isSourceArticle, isThoughtInboxArticle, pickRediscoverySource } from "../app/article-helpers";

test("keeps external sources out of the thought inbox", () => {
  const source = { branch: "待分类", collection: "sources", type: "外部资料" };

  assert.equal(isSourceArticle(source), true);
  assert.equal(isThoughtInboxArticle(source), false);
});

test("keeps unfinished quick captures in the thought inbox", () => {
  const capture = { branch: "待分类", collection: "notes", type: "灵感" };

  assert.equal(isSourceArticle(capture), false);
  assert.equal(isThoughtInboxArticle(capture), true);
});

test("rediscovers a recent collection when it matches today's context", () => {
  const source = savedSource({ title: "科研方向判断方法", created: "2026-08-13" });

  const result = pickRediscoverySource([source], "科研方向选择", "2026-08-13");

  assert.equal(result?.article.title, source.title);
  assert.match(result?.reason || "", /科研方向/);
});

test("rediscovers an old unarchived collection without forcing a project", () => {
  const archived = savedSource({ title: "已归档内容", branch: "已归档", created: "2026-07-01" });
  const old = savedSource({ title: "久未查看的收藏", created: "2026-08-01" });

  const result = pickRediscoverySource([archived, old], "", "2026-08-13");

  assert.equal(result?.article.title, old.title);
  assert.match(result?.reason || "", /12 天/);
});

function savedSource(overrides: Partial<{
  branch: string;
  title: string;
  created: string;
}> = {}) {
  return {
    branch: overrides.branch ?? "收藏中",
    collection: "sources",
    type: "外部资料",
    title: overrides.title ?? "一条收藏",
    summary: "",
    body: "",
    tags: [],
    source: ["外部链接", "https://example.com"],
    created: overrides.created ?? "2026-08-13",
  };
}
