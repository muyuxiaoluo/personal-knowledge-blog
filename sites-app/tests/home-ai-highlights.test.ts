import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { AiBriefItem, AiBriefSnapshot } from "../app/dashboard-types";

test("home AI preview stays bounded while the dialog retains every story, filters interests and preserves collection actions", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const originals = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const { createRoot } = await import("react-dom/client");
  const { HomeAiHighlights } = await import("../desktop/HomeAiHighlights");
  const document = dom.window.document;
  const root = createRoot(document.getElementById("root")!);
  const items: AiBriefItem[] = Array.from({ length: 20 }, (_, index) => ({ id: String(index), title: `消息 ${index}`, summary: index % 2 ? "GPT 相关摘要" : "其他摘要", reason: "", sourceName: "示例来源", category: "", publishedAt: "2026-10-28T07:00:00+08:00", score: 0, originalUrl: `https://example.com/${index}`, aihotUrl: `https://example.com/ai/${index}` }));
  const snapshot: AiBriefSnapshot = { items, topics: [], daily: { date: "2026-10-28", lead: "长篇日报导语", url: "https://example.com/daily" }, attribution: { name: "AIHOT", url: "https://example.com" } };
  const saved: AiBriefItem[] = [];
  const opened: string[] = [];
  const props = { snapshot: snapshot as AiBriefSnapshot | null, keywords: ["GPT"], savedIds: new Set<string>(), busy: false, error: "", onRefresh: () => {}, sourceStatus: createElement("footer", null, "更新于 19:00"), onOpenExternal: async (url: string) => { opened.push(url); }, onSave: async (item: AiBriefItem) => { saved.push(item); } };
  const render = async (patch: Partial<typeof props> = {}) => { await act(() => root.render(createElement(HomeAiHighlights, { ...props, ...patch }))); };
  const click = async (name: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === name || item.getAttribute("aria-label") === name)!;
    assert.ok(button, `Missing button: ${name}`);
    await act(async () => button.click());
  };
  const cancel = async () => { await act(() => document.querySelector("dialog")!.dispatchEvent(new dom.window.Event("cancel", { cancelable: true }))); };
  try {
    await render();
    assert.equal(document.querySelectorAll(".ai-focus-list li").length, 3);
    assert.deepEqual([...document.querySelectorAll(".ai-focus-list strong")].map((item) => item.textContent), ["消息 1", "消息 3", "消息 5"]);
    assert.equal(document.querySelectorAll(".ai-focus-list time").length, 3);
    assert.doesNotMatch(document.getElementById("root")!.textContent!, /相关摘要|其他摘要|长篇日报导语/);
    await click("消息 1");
    assert.deepEqual(opened, [items[1].aihotUrl]);
    await click("AI 日报 · 10/28 ↗");
    assert.equal(opened[1], snapshot.daily!.url);
    await click("还有 7 条关注，点击查看 →");
    assert.equal(document.querySelector<HTMLDialogElement>("dialog")!.open, true);
    assert.equal(document.querySelectorAll(".ai-news-list li").length, 10);
    await click("全部 20");
    assert.equal(document.querySelectorAll(".ai-news-list li").length, 20);
    assert.equal(document.querySelectorAll(".ai-news-summary[open]").length, 0);
    const firstSummary = document.querySelector<HTMLDetailsElement>(".ai-news-summary")!;
    await act(() => firstSummary.querySelector("summary")!.click());
    assert.equal(firstSummary.open, true);
    assert.equal(firstSummary.querySelector("p")!.textContent, items[1].summary);
    await click("收藏");
    assert.deepEqual(saved, [items[1]]);
    await render({ savedIds: new Set([items[1].id]) });
    assert.equal([...document.querySelectorAll<HTMLButtonElement>(".ai-news-item-actions button")].find((item) => item.textContent === "已收藏")!.disabled, true);
    await cancel();
    assert.equal(document.querySelector("dialog"), null);
    await click("查看全部动态 · 20 →");
    assert.equal(document.querySelectorAll(".ai-news-list li").length, 20);
    await click("关闭 AI 动态");
    await render({ keywords: ["不存在的关注词"] });
    assert.equal(document.querySelector(".ai-focus-list"), null);
    assert.match(document.querySelector(".ai-focus-empty")!.textContent!, /暂无关注词命中/);
    await click("查看全部动态 · 20 →");
    await click("我的关注 0");
    assert.equal(document.querySelectorAll(".ai-news-list li").length, 0);
    assert.match(document.querySelector(".ai-news-empty")!.textContent!, /暂无关注词命中/);
    await cancel();
    await render({ keywords: [] });
    assert.match(document.querySelector(".ai-focus-empty")!.textContent!, /设置关注词后/);
    await render({ snapshot: { ...snapshot, items: items.slice(0, 2) } });
    assert.equal(document.querySelectorAll(".ai-focus-list li").length, 1);
    await render({ snapshot: null, error: "网络暂不可用" });
    assert.match(document.querySelector(".ai-focus-empty")!.textContent!, /网络暂不可用/);
    await click("查看全部动态 · 0 →");
    assert.match(document.querySelector(".ai-news-empty")!.textContent!, /网络暂不可用/);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    for (const key of ["window", "document", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) {
      if (originals[key]) Object.defineProperty(globalThis, key, originals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
