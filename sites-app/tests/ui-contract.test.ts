import assert from "node:assert/strict";
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
