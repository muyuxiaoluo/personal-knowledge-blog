import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("builds the private mind garden entry point", async () => {
  const [layout, page] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    access(new URL("../dist/server/index.js", import.meta.url)),
  ]);

  assert.match(layout, /人生攻略库 · 私人思考花园/);
  assert.match(layout, /本地优先的私人思考工作台/);
  assert.match(page, /KnowledgeWorkbench/);
  assert.doesNotMatch(layout, /Starter Project|codex-preview/i);
});

test("keeps the private workflow in the main workbench", async () => {
  const [workbench, css, sqliteRepository] = await Promise.all([
    readFile(new URL("../app/KnowledgeWorkbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(
      new URL("../app/data/sqlite-article-repository.ts", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(workbench, /quickCapture/);
  assert.match(workbench, /recordEcho/);
  assert.match(workbench, /生活实验室/);
  assert.match(workbench, /思考花园/);
  assert.match(workbench, /不必分类，先让它存在/);
  assert.match(workbench, /HttpArticleRepository/);
  assert.doesNotMatch(workbench, /fetch\("\/api\/articles"/);
  assert.match(sqliteRepository, /class SqliteArticleRepository/);
  assert.match(sqliteRepository, /listPendingChanges/);
  assert.match(sqliteRepository, /deleted_at/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\.mobile-nav/);
});
