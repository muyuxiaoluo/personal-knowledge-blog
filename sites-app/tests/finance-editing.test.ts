import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { FINANCE_CATEGORIES, FINANCE_BUDGET_ROLES, type FinanceTransaction } from "../app/finance-types";
import { FINANCE_QUICK_CATEGORIES, FINANCE_QUICK_ROLES, isManualFinanceTransaction } from "../app/finance-classification";

async function fixture(t: test.TestContext) {
  const dom = new JSDOM('<div id="root"></div>');
  const originals = Object.getOwnPropertyDescriptors(globalThis);
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  t.after(async () => {
    await act(() => root.unmount()); dom.window.close();
    for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"]) {
      if (originals[key]) Object.defineProperty(globalThis, key, originals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const button = (label: string) => {
    const found = [...dom.window.document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label || item.querySelector("strong")?.textContent === label);
    assert.ok(found, `Missing button: ${label}`); return found;
  };
  return { dom, root, button, click: async (label: string) => { await act(async () => button(label).click()); } };
}

test("simple category and spending choices cover history and preserve existing detail unless another group is selected", async t => {
  assert.deepEqual(FINANCE_QUICK_CATEGORIES.flatMap(group => group.members).sort(), FINANCE_CATEGORIES.map(item => item.value).sort());
  assert.deepEqual(FINANCE_QUICK_ROLES.flatMap(group => group.members).sort(), FINANCE_BUDGET_ROLES.map(item => item.value).sort());
  const f = await fixture(t);
  const { FinanceSpendingFields } = await import("../desktop/FinanceSpendingFields");
  let category = "digital" as FinanceTransaction["category"], budgetRole = "growth" as FinanceTransaction["budgetRole"];
  const render = async () => { await act(() => f.root.render(createElement(FinanceSpendingFields, { category, budgetRole, onCategory: value => { category = value; }, onRole: value => { budgetRole = value; } }))); };
  await render();
  assert.equal(f.dom.window.document.querySelectorAll("button").length, 11);
  assert.equal(f.button("购物").getAttribute("aria-pressed"), "true");
  assert.equal(f.button("自主安排").getAttribute("aria-pressed"), "true");
  await f.click("购物"); await f.click("自主安排");
  assert.equal(category, "digital"); assert.equal(budgetRole, "growth");
  await f.click("吃喝"); await f.click("日常需要"); await render();
  assert.equal(category, "food"); assert.equal(budgetRole, "variable-essential");
  assert.equal(f.button("吃喝").getAttribute("aria-pressed"), "true");
  await f.click("暂不判断"); assert.equal(budgetRole, "unknown");
  assert.equal(isManualFinanceTransaction({ id: "manual", importBatchId: null }), true);
  assert.equal(isManualFinanceTransaction({ id: "imported", importBatchId: "batch" }), false);
  assert.equal(isManualFinanceTransaction({ id: "finance-capture-notification", importBatchId: null }), false);
});

test("deletion identifies the exact bill, lets users cancel, retains errors and prevents repeat submission", async t => {
  const f = await fixture(t);
  const { DeleteFinanceTransactionDialog } = await import("../desktop/DeleteFinanceTransactionDialog");
  const transaction = { id: "wrong-manual", merchant: "补错的一笔", occurredAt: "2026-10-31T12:00:00", amountCents: 1700 } as FinanceTransaction;
  const attempts: string[] = []; let closed = 0, deleted = 0;
  let succeed = false, release: (() => void) | undefined;
  const repository = { deleteManualTransaction: async (id: string) => { attempts.push(id); if (!succeed) throw new Error("保存失败，请重试"); await new Promise<void>(resolve => { release = resolve; }); } };
  await act(() => f.root.render(createElement(DeleteFinanceTransactionDialog, { transaction, repository, onClose: () => { closed++; }, onDeleted: () => { deleted++; } })));
  assert.match(f.dom.window.document.body.textContent!, /补错的一笔.*¥17\.00.*2026-10-31 12:00/s);
  await f.click("保留账单"); assert.equal(closed, 1); assert.deepEqual(attempts, []);
  await f.click("确认删除");
  assert.equal(f.dom.window.document.querySelector('[role="alert"]')?.textContent, "保存失败，请重试");
  assert.equal(deleted, 0);
  succeed = true;
  await f.click("确认删除");
  assert.equal(f.button("正在删除…").disabled, true);
  assert.equal(f.button("保留账单").disabled, true);
  await f.click("正在删除…"); assert.equal(attempts.length, 2);
  await act(async () => release!()); assert.equal(deleted, 1);
  assert.deepEqual(attempts, ["wrong-manual", "wrong-manual"]);
});

test("monthly review lets users exclude a bill, keeps selection after failure and prevents double submission", async t => {
  const f = await fixture(t);
  const { FinanceMonthlyReview } = await import("../desktop/FinanceMonthlyReview");
  const transactions = ["first", "second"].map(id => ({ id, merchant: "地铁公司", merchantNormalized: "地铁公司", description: "地铁扣费", category: "metro", kind: "expense", categoryConfirmed: false, importBatchId: "batch", occurredAt: "2026-08-01T08:00:00", amountCents: 300 } as FinanceTransaction));
  const attempts: string[][] = []; let fail = true, release: (() => void) | undefined;
  await act(() => f.root.render(createElement(FinanceMonthlyReview, {
    transactions, onImport: () => {}, onManual: () => {},
    onConfirm: async (_key, ids, category, remember) => {
      attempts.push(ids); assert.equal(category, "metro"); assert.equal(remember, true);
      if (fail) throw new Error("保存未完成");
      await new Promise<void>(resolve => { release = resolve; });
    },
  })));
  assert.match(f.dom.window.document.body.textContent!, /1 组消费待分类/);
  const checks = f.dom.window.document.querySelectorAll<HTMLInputElement>('.wealth-review-items input');
  await act(() => checks[1].click());
  await f.click("确认 1 笔分类");
  assert.equal(f.dom.window.document.querySelector('[role="alert"]')?.textContent, "保存未完成");
  assert.deepEqual(attempts, [["first"]]);
  fail = false;
  await f.click("确认 1 笔分类");
  assert.equal(f.button("正在保存…").disabled, true);
  await f.click("正在保存…"); assert.equal(attempts.length, 2);
  await act(async () => release!());
  assert.equal(checks[1].checked, false);
});
