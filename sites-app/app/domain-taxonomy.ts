export type LifeDomain =
  | "learning"
  | "career"
  | "creative"
  | "life"
  | "wellbeing"
  | "relationships"
  | "interests"
  | "systems"
  | "uncategorized";

export const LIFE_DOMAIN_OPTIONS: Array<{ value: LifeDomain; label: string }> = [
  { value: "learning", label: "学习与研究" },
  { value: "career", label: "工作与事业" },
  { value: "creative", label: "创作与表达" },
  { value: "life", label: "生活与家庭" },
  { value: "wellbeing", label: "身心与成长" },
  { value: "relationships", label: "人际与关系" },
  { value: "interests", label: "兴趣与探索" },
  { value: "systems", label: "工具与系统" },
  { value: "uncategorized", label: "未分类" },
];

export const LIFE_DOMAIN_LABELS = Object.fromEntries(
  LIFE_DOMAIN_OPTIONS.map((option) => [option.value, option.label]),
) as Record<LifeDomain, string>;

const legacyDomains: Record<string, LifeDomain> = {
  research: "learning",
  科研: "learning",
  学习: "learning",
  product: "systems",
  maintenance: "systems",
  support: "systems",
  产品: "systems",
  工具: "systems",
  creative: "creative",
  创作: "creative",
  personal: "uncategorized",
  个人项目: "uncategorized",
  个人产品: "systems",
  笔记: "uncategorized",
  个人笔记: "uncategorized",
  探索资料: "uncategorized",
  工具评测: "systems",
  提示词与模板库: "systems",
  模板库: "systems",
  学习方法与知识整理: "learning",
  思考随笔: "wellbeing",
  复盘日志: "wellbeing",
  项目档案: "systems",
};

export function normalizeLifeDomain(value: string | null | undefined): LifeDomain {
  const normalized = value?.trim() ?? "";
  if (LIFE_DOMAIN_OPTIONS.some((option) => option.value === normalized)) return normalized as LifeDomain;
  return legacyDomains[normalized] ?? "uncategorized";
}

const domainKeywords: Array<{ value: LifeDomain; pattern: RegExp }> = [
  { value: "learning", pattern: /学习|研究|科研|论文|课程|知识|阅读|实验|数据集|毕业|导师/ },
  { value: "career", pattern: /工作|职业|事业|业务|客户|公司|求职|面试|运营|商业/ },
  { value: "creative", pattern: /创作|写作|小说|绘画|音乐|摄影|设计|表达|文章|视频/ },
  { value: "life", pattern: /生活|家庭|家务|财务|消费|居住|旅行|饮食|整理/ },
  { value: "wellbeing", pattern: /健康|运动|睡眠|情绪|心理|成长|习惯|反思|自我/ },
  { value: "relationships", pattern: /人际|关系|朋友|伴侣|沟通|社交|家人|同事/ },
  { value: "interests", pattern: /兴趣|探索|游戏|动漫|电影|收藏|爱好|新奇/ },
  { value: "systems", pattern: /工具|系统|软件|产品|开发|编程|代码|工作流|自动化|机器人|AI|应用/ },
];

export function inferLifeDomain(...values: Array<string | null | undefined>): LifeDomain {
  for (const value of values) {
    const normalized = normalizeLifeDomain(value);
    if (normalized !== "uncategorized") return normalized;
  }
  const text = values.filter(Boolean).join(" ");
  return domainKeywords.find((entry) => entry.pattern.test(text))?.value ?? "uncategorized";
}
