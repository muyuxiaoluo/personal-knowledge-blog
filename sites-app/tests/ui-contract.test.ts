import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inspectComponent, inspectStyleEntry } from "../scripts/check-ui-primitives.mjs";

test("UI guard catches an unstyled action even with JSX comparisons and multiline handlers", () => {
  assert.equal(inspectComponent(`<button disabled={date > today}
    onClick={() => save(date)}>补记当天情况</button>`, "desktop/Page.tsx").length, 1);
  assert.equal(inspectComponent(`<Button disabled={date > today}>补记当天情况</Button>`, "desktop/Page.tsx").length, 0);
});

test("UI guard preserves custom navigation and content cards", () => {
  assert.deepEqual(inspectComponent(`<><button className={active ? "active" : ""}>导航</button>
    <button><strong>笔记标题</strong><small>更新时间</small></button></>`, "desktop/Page.tsx"), []);
  assert.equal(inspectComponent(`<button className="primary">保存</button>`, "desktop/Page.tsx").length, 1);
  assert.equal(inspectComponent(`<button className="focus-start">开始投入</button>`, "desktop/Page.tsx").length, 1);
});

test("UI guard permits registered page layers but rejects loading shared CSS from a page", () => {
  assert.equal(inspectComponent(`import "./styles/notes.css";`, "desktop/Page.tsx").length, 1);
  assert.equal(inspectComponent(`const Styles = lazy(async () => { await import("./styles/notes.css"); });`, "desktop/Page.tsx").length, 1);
  assert.equal(inspectComponent(`void import("./font-wenkai.css");`, "desktop/Page.tsx").length, 0);
  assert.equal(inspectComponent(`import "./styles/project-refinements.css";`, "desktop/Page.tsx").length, 0);
});

test("UI guard protects component priority over page selectors", () => {
  const order = "@layer pages, visual, controls;";
  assert.deepEqual(inspectStyleEntry(`${order}
    @import "./styles/dashboard.css" layer(pages);
    @import "./styles/visual-system.css" layer(visual);
    @import "./styles/controls.css" layer(controls);`), []);
  assert.equal(inspectStyleEntry(`${order} @import "./styles/workbench.css";`).length, 1);
  assert.equal(inspectStyleEntry("@layer controls, pages, visual;").length, 1);
});

test("health AI styling uses the shared light card contrast", () => {
  const styles = readFileSync(new URL("../desktop/styles/health.css", import.meta.url), "utf8");
  assert.match(styles, /\.health-ai-card\s*\{[^}]*color:\s*var\(--ink\)/s);
  assert.doesNotMatch(styles, /\.health-ai-card\s*\{[^}]*background:\s*linear-gradient/s);
});

test("sync center contains long attachment errors without horizontal scrolling", () => {
  const styles = readFileSync(new URL("../desktop/styles/foundation.css", import.meta.url), "utf8");
  assert.match(styles, /\.account-dialog\s*\{[^}]*overflow-x:\s*hidden/s);
  assert.match(styles, /\.sync-center-body\s*\{[^}]*overflow-x:\s*hidden/s);
  assert.match(styles, /\.sync-center-item\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto/s);
  assert.match(styles, /\.sync-error-detail code\s*\{[^}]*overflow-wrap:\s*anywhere/s);
});

test("project route relationships are edited directly on the graph", () => {
  const source = readFileSync(new URL("../desktop/ProjectRouteGraph.tsx", import.meta.url), "utf8");
  assert.match(source, /className="route-connect-target"/);
  assert.match(source, /aria-pressed=\{connectionSelected\}/);
  assert.doesNotMatch(source, /route-parent-options|与哪个任务并行/);
});

test("project AI keeps next-action help inside the selected branch and exposes durable accumulation", () => {
  const source = readFileSync(new URL("../desktop/ProjectWorkspace.tsx", import.meta.url), "utf8");
  assert.match(source, /AI 帮我填写/);
  assert.match(source, /已积累/);
  assert.match(source, /AI 推荐主线/);
  assert.match(source, /贴一张积累便签/);
  assert.doesNotMatch(source, /积累类型|已经完成了什么|关键结论或可复用价值/);
  assert.match(source, /buildBranchAiContext\(detail, milestone/);
  assert.doesNotMatch(source, />建议下一步</);
  assert.doesNotMatch(source, /openPanel\("next"\)/);
});

test("DeepSeek assistant follows the unified official conversation surface", () => {
  const source = readFileSync(new URL("../desktop/AiAssistantDialog.tsx", import.meta.url), "utf8");
  assert.match(source, /adapterVersion:\s*12/);
  assert.match(source, /我是 DeepSeek/);
  assert.doesNotMatch(source, /PrimaryModeSelector|快速模式|专家模式/);
});

test("note editing hydrates the full article independently from summary rows", () => {
  const source = readFileSync(new URL("../desktop/DesktopWorkbench.tsx", import.meta.url), "utf8");
  assert.match(source, /useState<StoredArticle \| null>\(null\)/);
  assert.match(source, /async function startEditing[\s\S]*repository\.get\(article\.id\)/);
  assert.doesNotMatch(source, /articles\.find\(\(article\) => article\.id === selectedId\)/);
});
