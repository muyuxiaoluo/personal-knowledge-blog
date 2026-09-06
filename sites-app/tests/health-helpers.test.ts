import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeHealthDay,
  buildHealthAiInput,
  calculateBmi,
  calculateSleepMinutes,
  classifyBmi,
  formatHealthAiAdviceMarkdown,
  validateHealthAiAdviceContent,
} from "../app/health-helpers";
import { emptyHealthDailyLog, emptyHealthProfile } from "../app/health-types";

test("calculates cross-midnight sleep and subtracts awake time", () => {
  assert.equal(calculateSleepMinutes("23:30", "07:15", 15), 450);
  assert.equal(calculateSleepMinutes("", "07:15", 0), null);
  assert.equal(calculateSleepMinutes("08:00", "08:00", 0), 1_440);
});

test("uses Chinese adult BMI bands", () => {
  assert.equal(calculateBmi(60, 170), 20.8);
  assert.equal(classifyBmi(18.4), "underweight");
  assert.equal(classifyBmi(18.5), "healthy");
  assert.equal(classifyBmi(24), "overweight");
  assert.equal(classifyBmi(28), "obese");
});

test("describes only meal categories visible in the text", () => {
  const profile = { ...emptyHealthProfile, heightCm: 170, currentWeightKg: 60, allergies: "花生" };
  const daily = { ...emptyHealthDailyLog("2026-08-31"), sleepStart: "23:30", sleepEnd: "07:00", steps: 3_000 };
  const result = analyzeHealthDay(profile, daily, [
    { date: daily.date, slot: "breakfast", eatenAt: "08:00", description: "燕麦牛奶和鸡蛋", updatedAt: "" },
    { date: daily.date, slot: "lunch", eatenAt: "12:00", description: "米饭、鱼和西兰花", updatedAt: "" },
  ]);
  assert.equal(result.sleepMinutes, 450);
  assert.deepEqual(result.mealSignals, ["主食", "蔬菜", "优质蛋白"]);
  assert.deepEqual(result.missingMealSignals, ["水果"]);
  assert.match(result.nextMealSuggestions[0], /水果/);
  assert.match(result.nextMealSuggestions[0], /花生/);
});

test("builds structured AI input from only the selected health records", () => {
  const input = buildHealthAiInput({
    date: "2026-08-31",
    profile: { ...emptyHealthProfile, avoidFoods: "辣椒" },
    daily: { ...emptyHealthDailyLog("2026-08-31"), steps: 8_000 },
    meals: [],
    recentLogs: [],
  });
  assert.equal(input.date, "2026-08-31");
  assert.equal(input.profile.avoidFoods, "辣椒");
  assert.equal(input.today.steps, 8_000);
  assert.equal(input.today.calculatedSleepMinutes, null);
  assert.deepEqual(input.meals, []);
});

test("validates and formats structured health advice", () => {
  const content = validateHealthAiAdviceContent({
    summary: "今天整体节奏较平稳。",
    facts: ["记录了 8000 步。"],
    sleepAdvice: ["今晚保留稳定的入睡窗口。"],
    activityAdvice: ["每小时起身活动几分钟。"],
    nextMeal: {
      focus: "优先补充蔬菜和蛋白质。",
      options: [
        { title: "家常搭配", foods: ["米饭", "青菜", "豆腐"], reason: "结构较完整。" },
        { title: "面食搭配", foods: ["面条", "鸡蛋", "番茄"], reason: "准备方便。" },
        { title: "简便搭配", foods: ["燕麦", "牛奶", "水果"], reason: "适合时间紧时。" },
      ],
    },
    attention: [],
    limitations: ["餐食没有份量信息。"],
  });
  assert.match(formatHealthAiAdviceMarkdown(content), /## 下一顿怎么吃/);
  assert.match(formatHealthAiAdviceMarkdown(content), /方案三/);
  assert.throws(() => validateHealthAiAdviceContent({ ...content, unknown: true }), /字段不完整/);
});
