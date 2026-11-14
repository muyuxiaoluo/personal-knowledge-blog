import { normalizeFinanceMerchant } from "./finance-analysis";
import type { FinanceBudgetRole, FinanceCategory, FinanceCategoryRule, FinanceTransaction } from "./finance-types";

// Keep existing detailed values when their broader group has not changed.
export const FINANCE_QUICK_CATEGORIES: Array<{ value: FinanceCategory; label: string; example: string; members: FinanceCategory[] }> = [
  { value: "food", label: "吃喝", example: "三餐、饮料", members: ["food"] },
  { value: "transport", label: "出行", example: "通勤、打车、旅行", members: ["transport", "metro", "bus", "taxi", "cycling", "travel"] },
  { value: "daily", label: "购物", example: "日用品、衣物、数码", members: ["daily", "digital"] },
  { value: "housing", label: "居住缴费", example: "房租、水电、手续费", members: ["housing", "fees"] },
  { value: "health", label: "健康", example: "看病、买药", members: ["health"] },
  { value: "learning", label: "学习工作", example: "书课、工作工具", members: ["learning"] },
  { value: "entertainment", label: "休闲人情", example: "娱乐、礼物、聚会", members: ["entertainment", "relationships"] },
  { value: "other", label: "其他", example: "暂时想不清也可以", members: ["other"] },
];

export const FINANCE_QUICK_ROLES: Array<{ value: FinanceBudgetRole; label: string; example: string; members: FinanceBudgetRole[] }> = [
  { value: "variable-essential", label: "日常需要", example: "生活或工作用得上", members: ["fixed-essential", "variable-essential"] },
  { value: "quality", label: "自主安排", example: "兴趣、享受或自我提升", members: ["growth", "quality", "optional"] },
  { value: "unknown", label: "暂不判断", example: "先记下来，以后再说", members: ["unknown"] },
];

export const financeQuickCategory = (category: FinanceCategory) => FINANCE_QUICK_CATEGORIES.find(group => group.members.includes(category))!;
export const financeQuickRole = (role: FinanceBudgetRole) => FINANCE_QUICK_ROLES.find(group => group.members.includes(role))!;

export const isManualFinanceTransaction = (transaction: Pick<FinanceTransaction, "id" | "importBatchId">) => !transaction.importBatchId && !transaction.id.startsWith("finance-capture-");

type Classifiable = Pick<FinanceTransaction, "merchant" | "description" | "category">;

// A marketplace or mobility platform can sell several different kinds of services.
export function financeRuleMatch(transaction: Pick<FinanceTransaction, "merchant" | "description">): Pick<FinanceCategoryRule, "matchKind" | "matchValue"> {
  const merchant = normalizeFinanceMerchant(transaction.merchant);
  const description = normalizeFinanceMerchant(transaction.description);
  if (merchant && /美团|京东|淘宝|天猫|拼多多|抖音|滴滴|高德|哈啰|微信|财付通|支付宝/.test(merchant)) {
    return { matchKind: "merchant-description", matchValue: JSON.stringify([merchant, description]) };
  }
  return merchant ? { matchKind: "merchant", matchValue: merchant } : { matchKind: "description", matchValue: description };
}

export function financeRuleMatches(rule: FinanceCategoryRule, transaction: Pick<FinanceTransaction, "merchant" | "description">) {
  if (rule.matchKind === "merchant-description") return rule.matchValue === JSON.stringify([normalizeFinanceMerchant(transaction.merchant), normalizeFinanceMerchant(transaction.description)]);
  if (rule.matchKind === "description") return rule.matchValue === normalizeFinanceMerchant(transaction.description);
  // Old broad platform rules must not override more specific service descriptions.
  return financeRuleMatch(transaction).matchKind === "merchant" && rule.matchValue === normalizeFinanceMerchant(transaction.merchant);
}

export function financeTransportCategory(transaction: Pick<FinanceTransaction, "merchant" | "description">): FinanceCategory | null {
  const detect = (text: string) => ([
    ["metro", /地铁|轨道交通/], ["bus", /公交|公共汽车/],
    ["taxi", /打车|出租车|网约车|快车|专车|顺风车/], ["cycling", /单车|骑行|助力车/],
  ] as const).filter(([, pattern]) => pattern.test(text)).map(([category]) => category);
  const detail = detect(transaction.description);
  const categories = detail.length ? detail : detect(transaction.merchant);
  return categories.length === 1 ? categories[0] : categories.length > 1 ? "transport" : null;
}

export function financeReviewGroupKey(transaction: Classifiable) {
  const match = financeRuleMatch(transaction);
  return JSON.stringify([match.matchKind, match.matchValue, transaction.category]);
}

export function groupFinanceReview(transactions: FinanceTransaction[]) {
  const groups = new Map<string, { key: string; merchant: string; category: FinanceCategory; transactions: FinanceTransaction[] }>();
  for (const transaction of transactions) {
    if (!transaction.importBatchId || transaction.kind !== "expense" || transaction.categoryConfirmed || transaction.amountCents <= 0) continue;
    const key = financeReviewGroupKey(transaction);
    const group = groups.get(key) ?? { key, merchant: transaction.merchant || transaction.description || "未命名商户", category: transaction.category, transactions: [] };
    group.transactions.push(transaction);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.transactions.length - a.transactions.length || a.merchant.localeCompare(b.merchant, "zh-CN"));
}
