import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type { GlobalPlanningProposal } from "../app/ai-api-types";
import type { GlobalPlanningRecord, PlanningClarification } from "../app/global-planning";

test("planning results keep reasons collapsed and allow partial answers without losing failed submissions", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const originals = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import("react-dom/client");
  const { GlobalPlanningResults } = await import("../desktop/GlobalPlanningResults");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const document = dom.window.document;
  const proposal: GlobalPlanningProposal = {
    summary: "今天先收尾一件事。".repeat(25),
    suggestions: [{ projectId: "p", taskId: null, reason: "完整判断依据保留在这里", nextStep: "核对一页结论，确认后停。" }],
    questions: ["是否已经提交？", "今天能投入多久？"],
  };
  const submitted: PlanningClarification[][] = [];
  const props = {
    proposal, projects: [], tasks: [], today: "2026-10-23", busy: false, error: "",
    onAnswer: async (answers: PlanningClarification[]) => { submitted.push(answers); return false; },
    onOpenProject: () => {}, onOpenTask: () => {}, onPlanToday: () => {},
  };
  const render = async (patch: Partial<typeof props> = {}) => { await act(() => root.render(createElement(GlobalPlanningResults, { ...props, ...patch }))); };
  const answer = async (index: number, text: string) => {
    const field = document.querySelectorAll<HTMLTextAreaElement>("textarea")[index];
    await act(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
      field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  try {
    await render();
    assert.equal(document.querySelector<HTMLDetailsElement>(".planning-long-summary")?.open, false);
    assert.equal(document.querySelector<HTMLDetailsElement>(".planning-reason")?.open, false);
    assert.equal(document.querySelector(".planning-reason p")?.textContent, proposal.suggestions[0].reason);
    assert.equal(document.querySelector(".planning-next-step")?.textContent, "核对一页结论，确认后停。");
    const fields = document.querySelectorAll<HTMLTextAreaElement>("textarea");
    assert.equal(fields.length, 2);
    assert.equal(fields[0].labels?.[0].textContent, "是否已经提交？");
    const submit = document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    assert.equal(submit.disabled, true);
    await answer(0, "  已经提交，在等反馈。  ");
    assert.equal(submit.disabled, false);
    await act(() => submit.click());
    assert.deepEqual(submitted, [[{ question: "是否已经提交？", answer: "已经提交，在等反馈。" }]]);
    await render({ error: "连接中断，请重试" });
    assert.equal(document.querySelector('[role="alert"]')?.textContent, "连接中断，请重试");
    assert.equal(fields[0].value, "  已经提交，在等反馈。  ");
    await answer(1, "半小时");
    await act(() => submit.click());
    assert.deepEqual(submitted[1], [
      { question: "是否已经提交？", answer: "已经提交，在等反馈。" },
      { question: "今天能投入多久？", answer: "半小时" },
    ]);
    await render({ busy: true });
    assert.equal(fields[0].disabled, true);
    assert.equal(submit.disabled, true);
    assert.equal(fields[1].value, "半小时");
  } finally {
    await act(() => root.unmount());
    dom.window.close();
    for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"]) {
      if (originals[key]) Object.defineProperty(globalThis, key, originals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("assistant sends clarification rounds with the original request and retries without duplicating answers", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const originals = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const { createRoot } = await import("react-dom/client");
  const { GlobalPlanningAssistant } = await import("../desktop/GlobalPlanningAssistant");
  const { desktopApi } = await import("../desktop/integrationApi");
  const { cacheDeepSeekModels } = await import("../app/ai-model-settings");
  cacheDeepSeekModels([{ id: "deepseek-flash", object: "model", ownedBy: "deepseek" }]);
  const originalPlan = desktopApi.deepseek.planGlobally;
  const requests: Array<{ input: any }> = [];
  const records = new Map<string, GlobalPlanningRecord>();
  let failSave = false;
  const historyRepository = {
    savePlanningRecord: async (record: GlobalPlanningRecord) => { if (failSave) { failSave = false; throw new Error("写入失败"); } records.set(record.id, structuredClone(record)); },
    getPlanningRecord: async (id: string) => records.get(id) || null,
    listPlanningHistory: async (limit = 20, offset = 0) => [...records.values()].reverse().slice(offset, offset + limit).map((record) => ({ id: record.id, createdAt: record.createdAt, request: record.request, model: record.model, summary: record.proposal.summary })),
  };
  desktopApi.deepseek.planGlobally = async (request) => {
    requests.push(request);
    if (requests.length === 2) throw new Error("连接中断，请重试");
    return {
      content: { summary: requests.length < 3 ? "先确认提交情况" : "按新情况调整", suggestions: [], questions: requests.length < 3 ? ["报告是否已提交？", "今天能投入多久？"] : requests.length === 3 ? ["需要核对什么？"] : [] },
      model: "deepseek-flash", tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  const document = dom.window.document;
  const click = async (text: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text || item.getAttribute("aria-label") === text);
    assert.ok(button, `Missing button: ${text}`);
    await act(async () => { button.click(); });
  };
  const answer = async (selector: string, text: string) => {
    const field = document.querySelector<HTMLTextAreaElement>(selector)!;
    assert.ok(field);
    await act(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
      field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  try {
    const props = {
      input: { today: "2026-10-23", projects: [], tasks: [], focusSessions: [], weeklyFocus: null, dailySituations: [] },
      historyRepository,
      onOpenProject: () => {}, onOpenTask: () => {}, onPlanToday: () => {},
    };
    await act(() => root.render(createElement(GlobalPlanningAssistant, props)));
    await click("打开全局规划助手");
    assert.equal(document.querySelector<HTMLDialogElement>("dialog")?.open, true);
    await answer(".planning-body > label textarea", "今天只有30分钟");
    await click("梳理全局，建议下一步");
    await answer(".planning-question textarea", "已经提交，等待反馈");
    await click("补充并更新建议");
    assert.equal(document.querySelector('[role="alert"]')?.textContent, "连接中断，请重试");
    assert.equal(document.querySelector<HTMLTextAreaElement>(".planning-question textarea")?.value, "已经提交，等待反馈");
    await click("补充并更新建议");
    assert.deepEqual(requests[1].input.clarifications, requests[2].input.clarifications);
    assert.equal(requests[2].input.clarifications.length, 1);
    assert.equal(requests[2].input.request, "今天只有30分钟");
    assert.deepEqual(requests[2].input.previousProposal.questions, ["报告是否已提交？", "今天能投入多久？"]);
    assert.match(document.querySelector(".planning-answer-history")?.textContent || "", /已经提交，等待反馈/);
    assert.equal(document.querySelector<HTMLTextAreaElement>(".planning-question textarea")?.value, "");
    await answer(".planning-question textarea", "只核对一条数据");
    await click("补充并更新建议");
    assert.equal(requests[3].input.request, "今天只有30分钟");
    assert.deepEqual(requests[3].input.clarifications, [
      { question: "报告是否已提交？", answer: "已经提交，等待反馈" },
      { question: "需要核对什么？", answer: "只核对一条数据" },
    ]);
    assert.equal(document.querySelector(".planning-questions"), null);
    assert.match(document.querySelector(".planning-answer-history")?.textContent || "", /已补充 2 条信息/);
    assert.equal(requests.length, 4);
    assert.equal(records.size, 3);
    failSave = true;
    await click("重新梳理");
    assert.match(document.querySelector(".planning-save-error")?.textContent || "", /历史保存失败/);
    assert.equal(records.size, 3);
    assert.equal(requests.length, 5);
    await click("重试保存");
    assert.equal(records.size, 4);
    assert.equal(requests.length, 5);
    assert.equal(document.querySelector(".planning-save-error"), null);
    // Recreate the assistant: history remains available without a new AI request.
    await act(() => root.render(null));
    await act(() => root.render(createElement(GlobalPlanningAssistant, props)));
    await click("打开全局规划助手");
    await click("历史记录");
    assert.equal(document.querySelectorAll(".planning-history-list > button").length, 4);
    await act(async () => document.querySelector<HTMLButtonElement>(".planning-history-list > button")!.click());
    assert.match(document.querySelector(".planning-history-request")?.textContent || "", /今天只有30分钟/);
    assert.match(document.querySelector(".planning-history .planning-answer-history")?.textContent || "", /只核对一条数据/);
    assert.equal(document.querySelector(".planning-history .planning-questions"), null);
    assert.equal(document.querySelector(".planning-history .planning-result button"), null);
    assert.equal(requests.length, 5);
  } finally {
    desktopApi.deepseek.planGlobally = originalPlan;
    await act(() => root.unmount());
    dom.window.close();
    for (const key of ["window", "document", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]) {
      if (originals[key]) Object.defineProperty(globalThis, key, originals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
