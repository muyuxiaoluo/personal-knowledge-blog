import type { Article } from "./types";

export type NoteCategory =
  | "reflection"
  | "journal"
  | "learning"
  | "review"
  | "quick-note"
  | "uncategorized";

export const NOTE_CATEGORY_OPTIONS: Array<{ value: NoteCategory; label: string; description: string }> = [
  { value: "reflection", label: "思考感悟", description: "观点、道理、选择与生活感悟" },
  { value: "journal", label: "经历记录", description: "日常、见闻与值得留下的经历" },
  { value: "learning", label: "学习整理", description: "经过理解和消化的知识" },
  { value: "review", label: "经验复盘", description: "方法、教训与阶段性总结" },
  { value: "quick-note", label: "随手记", description: "以后可能查阅的简短信息" },
  { value: "uncategorized", label: "未分类", description: "暂时不确定放在哪里" },
];

export const NOTE_CATEGORY_LABELS = Object.fromEntries(
  NOTE_CATEGORY_OPTIONS.map((option) => [option.value, option.label]),
) as Record<NoteCategory, string>;

const directCategories = new Set<NoteCategory>(NOTE_CATEGORY_OPTIONS.map((option) => option.value));

const legacyCategories: Record<string, NoteCategory> = {
  思考随笔: "reflection",
  复盘日志: "review",
  学习方法与知识整理: "learning",
  提示词与模板库: "quick-note",
  模板库: "quick-note",
  工具评测: "review",
  项目档案: "quick-note",
};

const legacyNatures: Record<string, NoteCategory> = {
  知识: "learning",
  结论: "learning",
  教程: "learning",
  思考: "reflection",
  想法: "reflection",
  灵感: "reflection",
  问题: "reflection",
  决策: "reflection",
  方法: "review",
  步骤: "review",
  经验: "review",
  复盘: "review",
  模板: "quick-note",
  资料: "quick-note",
  备忘: "quick-note",
};

const categoryKeywords: Array<{ value: NoteCategory; pattern: RegExp }> = [
  { value: "quick-note", pattern: /备忘|清单|模板|提示词|摘录|参考资料|随手记/ },
  { value: "review", pattern: /复盘|经验|教训|踩坑|总结|评测|方法|工作流/ },
  { value: "learning", pattern: /学习|知识|课程|论文|研究|读书|概念|教程|指南/ },
  { value: "journal", pattern: /日记|经历|回忆|难忘|旅行|见闻|日常记录|生活记录/ },
  { value: "reflection", pattern: /感悟|思考|想法|道理|反思|观点|人生|情绪|选择|决定|成长/ },
];

type NoteCategoryInput = Partial<Pick<Article, "category" | "type" | "title" | "summary" | "tags">>;

/**
 * Keeps legacy notes useful without rewriting them in bulk. Once a note is
 * explicitly organized, its new category value wins over all inference.
 */
export function inferNoteCategory(article: NoteCategoryInput): NoteCategory {
  const category = article.category?.trim() ?? "";
  if (directCategories.has(category as NoteCategory)) return category as NoteCategory;
  if (legacyCategories[category]) return legacyCategories[category];

  const natures = (article.type ?? "").split(/[，,]/).map((item) => item.trim()).filter(Boolean);
  for (const nature of natures) {
    if (legacyNatures[nature]) return legacyNatures[nature];
  }

  const text = [article.title, article.summary, ...(article.tags ?? [])].filter(Boolean).join(" ");
  return categoryKeywords.find((entry) => entry.pattern.test(text))?.value ?? "uncategorized";
}
