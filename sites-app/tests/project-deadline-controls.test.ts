import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { Milestone } from "../app/project-types";

test("deadline editing preserves failed changes, cancels cleanly and saves only a changed date", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const originals = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import("react-dom/client");
  const { StageDeadlineControls } = await import("../desktop/ProjectDeadlineControls");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const document = dom.window.document;
  const milestone: Milestone = { id: "checkpoint", projectId: "project", title: "验证插件", definitionOfDone: "主要功能可用", status: "current", dueDate: "2099-10-18", dueDateKind: "deadline", sortOrder: 0, createdAt: "", updatedAt: "" };
  const saved: Milestone[] = [];
  let succeeds = false;
  const props = { milestone, adaptive: true, hasCurrentAction: false, saving: false, onSave: async (value: Milestone) => { saved.push(value); return succeeds; } };
  const render = async (patch: Partial<typeof props> = {}) => { await act(() => root.render(createElement(StageDeadlineControls, { ...props, ...patch }))); };
  const click = async (text: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text)!;
    assert.ok(button, `Missing button: ${text}`);
    await act(async () => button.click());
  };
  const changeDate = async (value: string) => {
    const field = document.querySelector<HTMLInputElement>('input[type="date"]')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(field, value);
      field.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
  };
  try {
    await render();
    assert.match(document.querySelector("time")!.textContent!, /真实截止 · 2099-10-18/);
    await click("调整日期");
    assert.match(document.querySelector<HTMLInputElement>("input")!.labels?.[0].textContent || "", /检查点日期/);
    assert.equal(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
    await changeDate("2099-10-25");
    await click("保存日期");
    assert.deepEqual(saved, [{ ...milestone, dueDate: "2099-10-25" }]);
    assert.equal(document.querySelector<HTMLInputElement>("input")!.value, "2099-10-25");
    await render({ saving: true });
    assert.equal(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
    await render();
    await click("取消");
    assert.equal(document.querySelector("form"), null);
    await click("调整日期");
    assert.equal(document.querySelector<HTMLInputElement>("input")!.value, milestone.dueDate);
    await changeDate("");
    assert.equal(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, false);
    succeeds = true;
    await click("保存日期");
    assert.equal(document.querySelector("form"), null);
    assert.equal(saved[1].dueDate, "");
    assert.equal(saved[1].dueDateKind, null);
    await render({ adaptive: false });
    assert.match(document.querySelector("time")!.textContent!, /真实截止/);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"]) {
      if (originals[key]) Object.defineProperty(globalThis, key, originals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
