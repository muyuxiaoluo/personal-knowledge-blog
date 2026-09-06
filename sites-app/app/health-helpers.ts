import type { HealthAiAdviceContent, HealthDailyLog, HealthMeal, HealthProfile } from "./health-types";

export type BmiBand = "underweight" | "healthy" | "overweight" | "obese";

export type HealthDayAnalysis = {
  bmi: number | null;
  bmiBand: BmiBand | null;
  sleepMinutes: number | null;
  recordedMealCount: number;
  mealSignals: string[];
  missingMealSignals: string[];
  observations: string[];
  nextMealSuggestions: string[];
};

const mealSignalKeywords = [
  { label: "主食", words: ["饭", "米", "面", "粉", "粥", "馒头", "包子", "面包", "燕麦", "玉米", "红薯", "土豆"] },
  { label: "蔬菜", words: ["菜", "青椒", "西兰花", "番茄", "黄瓜", "白菜", "菠菜", "萝卜", "菌", "蘑菇"] },
  { label: "优质蛋白", words: ["蛋", "鸡", "鱼", "虾", "牛肉", "猪肉", "豆", "奶", "酸奶", "豆腐"] },
  { label: "水果", words: ["水果", "苹果", "香蕉", "橙", "梨", "葡萄", "莓", "桃", "西瓜"] },
] as const;

export function calculateBmi(weightKg: number | null, heightCm: number | null) {
  if (!weightKg || !heightCm || weightKg <= 0 || heightCm <= 0) return null;
  return Math.round((weightKg / ((heightCm / 100) ** 2)) * 10) / 10;
}

export function classifyBmi(bmi: number | null): BmiBand | null {
  if (bmi === null) return null;
  if (bmi < 18.5) return "underweight";
  if (bmi < 24) return "healthy";
  if (bmi < 28) return "overweight";
  return "obese";
}

export function bmiBandLabel(band: BmiBand | null) {
  if (band === "underweight") return "偏低";
  if (band === "healthy") return "适宜范围";
  if (band === "overweight") return "偏高";
  if (band === "obese") return "较高";
  return "待补充";
}

export function calculateSleepMinutes(start: string, end: string, awakeMinutes = 0) {
  const startMinutes = parseClock(start);
  const endMinutes = parseClock(end);
  if (startMinutes === null || endMinutes === null) return null;
  let duration = endMinutes - startMinutes;
  if (duration <= 0) duration += 24 * 60;
  return Math.max(0, duration - Math.max(0, awakeMinutes));
}

export function formatSleepDuration(minutes: number | null) {
  if (minutes === null) return "未记录";
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} 小时 ${remainder} 分` : `${hours} 小时`;
}

export function analyzeHealthDay(
  profile: HealthProfile,
  daily: HealthDailyLog,
  meals: HealthMeal[],
): HealthDayAnalysis {
  const weight = daily.weightKg ?? profile.currentWeightKg;
  const bmi = calculateBmi(weight, profile.heightCm);
  const bmiBand = classifyBmi(bmi);
  const sleepMinutes = calculateSleepMinutes(daily.sleepStart, daily.sleepEnd, daily.awakeMinutes);
  const mealText = meals.map((meal) => meal.description.trim()).filter(Boolean).join(" ");
  const mealSignals = mealSignalKeywords
    .filter((signal) => signal.words.some((word) => mealText.includes(word)))
    .map((signal) => signal.label);
  const missingMealSignals = mealSignalKeywords
    .map((signal) => signal.label)
    .filter((label) => !mealSignals.includes(label));
  const observations: string[] = [];

  if (sleepMinutes === null) observations.push("补充入睡和起床时间后，才能判断睡眠时长。 ");
  else if (sleepMinutes < 7 * 60) observations.push("本次记录的睡眠不足 7 小时，今晚可优先预留更完整的休息窗口。 ");
  else if (sleepMinutes > 8 * 60) observations.push("本次记录的睡眠超过成年人常见的 7—8 小时参考，可结合白天精神状态继续观察。 ");
  else observations.push("本次记录的睡眠时长处于成年人常见的 7—8 小时参考区间。 ");

  if (daily.steps === null) observations.push("补充今天的步数后，可得到更具体的活动建议。 ");
  else if (daily.steps < 6_000) observations.push("今天的步数低于常见日常活动参考，如果身体允许，可用短距离散步分段增加活动。 ");
  else if (daily.steps <= 10_000) observations.push("今天的步数处于常见日常活动参考范围，继续关注久坐间隔和身体感受即可。 ");
  else observations.push("今天的步数已经超过常见日常活动参考，不必为追求数字额外勉强运动。 ");

  if (!mealText) observations.push("还没有餐食文字，暂时无法分析饮食结构。 ");
  else if (missingMealSignals.length) observations.push(`当前文字记录中未明显看到：${missingMealSignals.join("、")}。`);
  else observations.push("当前文字记录覆盖了主食、蔬菜、蛋白质和水果等主要类别。 ");

  const avoid = [profile.allergies, profile.avoidFoods].filter(Boolean).join("、");
  const nextMealSuggestions = buildMealSuggestions(missingMealSignals, avoid);
  return {
    bmi,
    bmiBand,
    sleepMinutes,
    recordedMealCount: meals.filter((meal) => meal.description.trim()).length,
    mealSignals,
    missingMealSignals,
    observations,
    nextMealSuggestions,
  };
}

export function buildHealthAiInput(input: {
  date: string;
  profile: HealthProfile;
  daily: HealthDailyLog;
  meals: HealthMeal[];
  recentLogs: HealthDailyLog[];
}) {
  const { date, profile, daily, meals, recentLogs } = input;
  const recent = recentLogs
    .filter((item) => item.date <= date)
    .slice(0, 7)
    .map((item) => ({
      date: item.date,
      sleepMinutes: calculateSleepMinutes(item.sleepStart, item.sleepEnd, item.awakeMinutes),
      steps: item.steps,
      weightKg: item.weightKg,
      energyLevel: item.energyLevel,
    }));
  const mealSummary = meals.map((meal) => ({ slot: meal.slot, eatenAt: meal.eatenAt, description: meal.description }));
  return {
    date,
    profile: {
      age: profile.age,
      sex: profile.sex,
      heightCm: profile.heightCm,
      currentWeightKg: profile.currentWeightKg,
      targetWeightKg: profile.targetWeightKg,
      targetDate: profile.targetDate,
      dietPreferences: profile.dietPreferences,
      avoidFoods: profile.avoidFoods,
      allergies: profile.allergies,
      healthNotes: profile.healthNotes,
    },
    today: {
      sleepStart: daily.sleepStart,
      sleepEnd: daily.sleepEnd,
      awakeMinutes: daily.awakeMinutes,
      calculatedSleepMinutes: calculateSleepMinutes(daily.sleepStart, daily.sleepEnd, daily.awakeMinutes),
      sleepQuality: daily.sleepQuality,
      energyLevel: daily.energyLevel,
      steps: daily.steps,
      weightKg: daily.weightKg,
      activityMinutes: daily.activityMinutes,
      activityNote: daily.activityNote,
      note: daily.note,
    },
    meals: mealSummary,
    recent,
  };
}

export function validateHealthAiAdviceContent(value: unknown): HealthAiAdviceContent {
  const root = exactRecord(value, ["summary", "facts", "sleepAdvice", "activityAdvice", "nextMeal", "attention", "limitations"]);
  const nextMeal = exactRecord(root.nextMeal, ["focus", "options"]);
  if (!Array.isArray(nextMeal.options) || nextMeal.options.length !== 3) {
    throw new Error("AI 返回的下一餐方案不完整，请重新生成。 ");
  }
  const options = nextMeal.options.map((value) => {
    const option = exactRecord(value, ["title", "foods", "reason"]);
    return {
      title: requiredText(option.title),
      foods: textArray(option.foods, 1, 8),
      reason: requiredText(option.reason),
    };
  });
  return {
    summary: requiredText(root.summary),
    facts: textArray(root.facts, 0, 12),
    sleepAdvice: textArray(root.sleepAdvice, 0, 8),
    activityAdvice: textArray(root.activityAdvice, 0, 8),
    nextMeal: { focus: requiredText(nextMeal.focus), options },
    attention: textArray(root.attention, 0, 8),
    limitations: textArray(root.limitations, 0, 8),
  };
}

export function formatHealthAiAdviceMarkdown(advice: HealthAiAdviceContent) {
  const sections = [
    "## 今日概览",
    advice.summary,
    markdownList("记录事实", advice.facts),
    markdownList("睡眠建议", advice.sleepAdvice),
    markdownList("活动建议", advice.activityAdvice),
    "## 下一顿怎么吃",
    advice.nextMeal.focus,
    ...advice.nextMeal.options.flatMap((option, index) => [
      `### 方案${["一", "二", "三"][index]}`,
      `**${option.title}**`,
      `- 食物：${option.foods.join("、")}`,
      `- 理由：${option.reason}`,
    ]),
    markdownList("需要留意", advice.attention),
    markdownList("数据限制", advice.limitations),
  ];
  return sections.filter(Boolean).join("\n\n");
}

function exactRecord(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AI 返回的数据结构不完整，请重新生成。 ");
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record);
  if (actualKeys.length !== keys.length || keys.some((key) => !(key in record))) {
    throw new Error("AI 返回的数据字段不完整，请重新生成。 ");
  }
  return record;
}

function requiredText(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new Error("AI 返回的建议文字不完整，请重新生成。 ");
  return value.trim();
}

function textArray(value: unknown, minimum: number, maximum: number) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new Error("AI 返回的建议列表不完整，请重新生成。 ");
  }
  return value.map(requiredText);
}

function markdownList(title: string, items: string[]) {
  return `## ${title}\n\n${items.length ? items.map((item) => `- ${item}`).join("\n") : "- 暂无"}`;
}

function buildMealSuggestions(missing: string[], avoid: string) {
  const suggestions: string[] = [];
  if (missing.includes("蔬菜")) suggestions.push("在下一餐加一份颜色丰富的蔬菜");
  if (missing.includes("优质蛋白")) suggestions.push("选择一份适合你的蛋、豆制品、鱼或瘦肉");
  if (missing.includes("主食")) suggestions.push("搭配一份适量主食，优先考虑粗细搭配");
  if (missing.includes("水果")) suggestions.push("把水果放在两餐之间，按实际饥饿感选择");
  if (!suggestions.length) suggestions.push("保持荤素搭配，并根据饥饿感调整份量");
  return suggestions.slice(0, 3).map((item) => avoid ? `${item}（避开${avoid}）` : item);
}

function parseClock(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}
