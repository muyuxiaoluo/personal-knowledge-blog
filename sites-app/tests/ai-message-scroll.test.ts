import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useAiMessageScroll } from "../desktop/useAiMessageScroll";

test("chat follows output, respects reading history, resumes and handles layout changes", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  let resize = () => {};
  const original = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} },
  });
  let api: ReturnType<typeof useAiMessageScroll>;
  let height = 1000;
  let top = 0;
  function Chat({ conversation, text }: { conversation: string; text: string }) {
    api = useAiMessageScroll(true, conversation);
    return createElement("div", { ref: (node: HTMLDivElement | null) => {
      api.scrollRef.current = node;
      if (node) Object.defineProperties(node, {
        scrollHeight: { configurable: true, get: () => height },
        clientHeight: { configurable: true, get: () => 300 },
        scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, height - 300)); } },
      });
    }, onScroll: api.onScroll }, createElement("div", { ref: api.contentRef }, text));
  }
  const root = createRoot(dom.window.document.getElementById("root")!);
  const update = async (text: string, conversation = "first") => {
    await act(() => root.render(createElement(Chat, { text, conversation })));
  };
  try {
    await update("回答开始");
    assert.equal(top, 700);
    height = 1400;
    await update("新增输出");
    assert.equal(top, 1100);
    top = 500;
    await act(() => api!.onScroll());
    assert.equal(api!.showLatest, true);
    height = 1800;
    await update("继续输出");
    assert.equal(top, 500);
    await act(() => resize());
    assert.equal(top, 500);
    await act(() => api!.scrollToLatest());
    assert.equal(top, 1500);
    assert.equal(api!.showLatest, false);
    height = 2000;
    await act(() => resize());
    assert.equal(top, 1700);
    top = 800;
    await act(() => api!.onScroll());
    top = 1700;
    await act(() => api!.onScroll());
    height = 2200;
    await update("手动回到底部后继续输出");
    assert.equal(top, 1900);
    top = 800;
    await act(() => api!.onScroll());
    await update("切换会话", "second");
    assert.equal(top, 1900);
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver"]) {
      if (original[key]) Object.defineProperty(globalThis, key, original[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
