import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { ModelBalance } from "../app/integration-types";

test("one balance entry previews both providers on hover, keeps focus usable and supports pinning", async () => {
  const dom = new JSDOM('<div id="root"></div><button id="outside">Outside</button>');
  const originals = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import("react-dom/client");
  const { HomeBalancePopover } = await import("../desktop/HomeAccountBalances");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const document = dom.window.document;
  const originalMatches = dom.window.HTMLElement.prototype.matches;
  dom.window.HTMLElement.prototype.matches = function (selector) { return selector === ":popover-open" ? this.hasAttribute("data-open") : originalMatches.call(this, selector); };
  function toggle(element: HTMLElement, open: boolean) {
    element.toggleAttribute("data-open", open);
    const event = new dom.window.Event("toggle");
    Object.assign(event, { newState: open ? "open" : "closed" });
    element.dispatchEvent(event);
  }
  Object.assign(dom.window.HTMLElement.prototype, { showPopover(this: HTMLElement) { toggle(this, true); }, hidePopover(this: HTMLElement) { toggle(this, false); } });
  let openedTools = 0;
  const balance: ModelBalance = { provider: "deepseek", available: true, amount: "9.83", cashAmount: "9.83", grantedAmount: "0", currency: "CNY", fetchedAt: "2026-10-25T08:00:00Z", message: "" };
  const pointer = (element: Element, type: string, relatedTarget: EventTarget | null = null) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, relatedTarget });
    Object.assign(event, { pointerType: "mouse" });
    element.dispatchEvent(event);
  };
  const wait = () => new Promise((resolve) => setTimeout(resolve, 210));
  try {
    await act(() => root.render(createElement(HomeBalancePopover, { balances: { deepseek: balance, qwen: { ...balance, provider: "qwen", amount: "2.28" } }, usage: {}, onOpenTools: () => { openedTools++; } })));
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="查看模型账户余额"]')!;
    const panel = document.querySelector<HTMLElement>('[popover]')!;
    assert.equal(document.querySelectorAll('.home-balance-entry > button').length, 1);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    await act(async () => { pointer(trigger, "pointerover"); await wait(); });
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.match(panel.textContent!, /DeepSeek[\s\S]*9.83[\s\S]*Qwen[\s\S]*2.28/);
    await act(async () => { pointer(trigger, "pointerout", panel); pointer(panel, "pointerover", trigger); await wait(); });
    assert.equal(panel.matches(":popover-open"), true);
    await act(async () => { pointer(panel, "pointerout", document.body); await wait(); });
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    await act(() => trigger.focus());
    assert.equal(panel.matches(":popover-open"), true);
    const manage = panel.querySelector<HTMLButtonElement>("button")!;
    await act(async () => { manage.focus(); await wait(); });
    assert.equal(panel.matches(":popover-open"), true);
    await act(() => manage.click());
    assert.equal(openedTools, 1);
    assert.equal(panel.matches(":popover-open"), false);
    await act(() => trigger.click());
    await act(async () => { pointer(trigger, "pointerout", document.body); await wait(); });
    assert.equal(panel.matches(":popover-open"), true);
    await act(() => trigger.click());
    assert.equal(panel.matches(":popover-open"), false);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    for (const key of ["window", "document", "Node", "IS_REACT_ACT_ENVIRONMENT"]) {
      if (originals[key]) Object.defineProperty(globalThis, key, originals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
