import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { ProjectRouteGraph } from "../desktop/ProjectRouteGraph";
import type { Milestone } from "../app/project-types";

test("route selection, connection editing and zoom preserve task boundaries", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const originals = Object.getOwnPropertyDescriptors(globalThis);
  let resize = () => {};
  let width = 634;
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} },
  });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    offsetWidth: { get() { return this.classList.contains("route-graph-board") ? 800 : 240; } },
    offsetHeight: { get() { return this.classList.contains("route-graph-board") ? 800 : 144; } },
    clientWidth: { get() { return width; } },
    clientHeight: { get() { return 434; } },
  });
  const node = (id: string, status: Milestone["status"], predecessorIds: string[]): Milestone => ({
    id, projectId: "p", title: id, definitionOfDone: `完整标准：${id}`, status, predecessorIds,
    dueDate: "", sortOrder: 0, createdAt: "2026-10-09", updatedAt: "2026-10-09",
  });
  const milestones = [node("起点", "completed", []), node("当前", "current", ["起点"]), node("后续", "planned", ["当前"])];
  let saved: Milestone | undefined;
  let focused: string | undefined;
  let saveSucceeds = false;
  const props = {
    projectId: "p", milestones, tasks: [], saving: false,
    onSave: async (value: Milestone) => { saved = value; return saveSucceeds; },
    onComplete: () => {}, onRemove: () => {}, onFocus: (value: Milestone) => { focused = value.id; },
  };
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const document = dom.window.document;
  const button = (text: string, scope: ParentNode = document) => {
    const element = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text || item.getAttribute("aria-label") === text);
    assert.ok(element, `Missing button: ${text}`);
    return element;
  };
  const click = async (text: string, scope?: ParentNode) => { await act(async () => { button(text, scope).click(); }); };
  const detail = () => document.querySelector(".route-detail-pane")!;
  try {
    await act(() => root.render(createElement(ProjectRouteGraph, props)));
    assert.equal(detail().querySelector("h3")?.textContent, "当前");
    assert.ok(detail().textContent?.includes("完整标准：当前"));
    assert.equal(document.querySelector(".route-task-card p"), null);
    await click("进入任务");
    assert.equal(focused, "当前");
    await click("查看任务：后续");
    assert.equal(detail().querySelector("h3")?.textContent, "后续");
    assert.equal(button("等待 1 项完成").disabled, true);
    await click("○ 当前", detail());
    await click("编辑连接");
    assert.equal(button("前置任务：后续").disabled, true);
    assert.equal(button("前置任务：起点").getAttribute("aria-pressed"), "true");
    await click("前置任务：起点");
    assert.equal(button("前置任务：起点").getAttribute("aria-pressed"), "false");
    await act(async () => { document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
    assert.deepEqual(saved?.predecessorIds, []);
    assert.equal(saved?.id, "当前");
    assert.ok(document.querySelector('[role="alert"]'));
    saveSucceeds = true;
    await act(async () => { document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
    assert.equal(document.querySelector("form"), null);
    assert.equal(milestones[1].predecessorIds?.[0], "起点");

    const board = document.querySelector<HTMLElement>(".route-graph-board")!;
    const edges = document.querySelector("svg")!.innerHTML;
    assert.equal(board.style.transform, "scale(0.75)");
    await click("查看全图");
    assert.equal(board.style.transform, "scale(0.5)");
    await click("原始大小");
    width = 434;
    await act(() => resize());
    assert.equal(board.style.transform, "scale(1)");
    await click("适合宽度");
    assert.equal(board.style.transform, "scale(0.5)");
    assert.equal(document.querySelector("svg")!.innerHTML, edges);
    await click("专注查看");
    assert.ok(document.querySelector('[role="dialog"][aria-modal="true"]'));
    await act(() => document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(detail().querySelector("h3")?.textContent, "当前");
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver"]) {
      if (originals[key]) Object.defineProperty(globalThis, key, originals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
