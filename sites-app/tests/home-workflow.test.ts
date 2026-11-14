import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQuickCloseout,
  contextualEchoTerms,
  findContextualEcho,
  selectContextualEcho,
  selectHomeTaskCandidates,
  type HomeTaskCandidate,
} from "../app/home-workflow";
import type { StoredArticle } from "../app/types";

function task(id: string, patch: Partial<HomeTaskCandidate> = {}): HomeTaskCandidate {
  return {
    id,
    projectId: "project-1",
    projectStatus: "active",
    status: "later",
    plan: null,
    planCarriedFrom: "",
    dueDate: "",
    stageDueDate: "",
    sortOrder: 0,
    ...patch,
  };
}

test("home starts from the active session, carry-over work, then an available next action", () => {
  const choices = selectHomeTaskCandidates([
    task("ordinary", { status: "next" }),
    task("carry", { plan: { taskId: "carry", plannedDate: "2026-09-14", priority: "normal", estimateMinutes: 0, sortOrder: 0, updatedAt: "" }, planCarriedFrom: "2026-09-14" }),
    task("active", { status: "waiting" }),
    task("done", { status: "done" }),
  ], "2026-09-15", "active");
  assert.deepEqual(choices.map((item) => item.id), ["active", "carry", "ordinary"]);
});

test("home does not turn every someday task into an automatic daily recommendation", () => {
  assert.deepEqual(selectHomeTaskCandidates([
    task("someday", { status: "later" }),
  ], "2026-09-15", null), []);
});

test("home prioritizes today's plan and hides future or blocked actions", () => {
  const today = "2026-11-12";
  const plan = (taskId: string, plannedDate: string) => ({ taskId, plannedDate, priority: "normal" as const, estimateMinutes: 30, sortOrder: 0, updatedAt: "" });
  const choices = selectHomeTaskCandidates([
    task("future", { status: "next", plan: plan("future", "2026-11-13") }),
    task("pending", { plan: plan("pending", ""), weekBlocked: true }),
    task("missed", { plan: plan("missed", "2026-11-11") }),
    task("today", { plan: plan("today", today) }),
  ], today, null);
  assert.deepEqual(choices.map((choice) => choice.id), ["today", "missed"]);
});

test("quick closeout needs only a choice and keeps the current focus by default", () => {
  assert.deepEqual(buildQuickCloseout("small_step", "", "", "继续整理实验结果"), {
    result: "完成了当前小步",
    nextFocus: "继续整理实验结果",
  });
  assert.equal(buildQuickCloseout("blocked", "等待数据", "换用缓存数据", "原步骤").result, "遇到阻塞，先停在这里：等待数据");
});

test("contextual echo can rediscover an older note from a body-only search match", async () => {
  const stored = article("older-note", "一个旧实验记录", "2026-09-01");
  const repository = {
    async listSummaries(_limit = 50, _offset = 0, query = "") {
      return "鲁棒性实验需要增加异常输入".includes(query) ? [{ ...stored, body: "" }] : [];
    },
  };
  const terms = contextualEchoTerms({
    projectTitle: "鲁棒性实验",
    stageTitle: "",
    title: "检查异常输入",
    currentFocus: "增加异常输入",
    benefit: "",
  }, null);
  const echo = await findContextualEcho(repository, terms, "2026-09-15");
  assert.equal(echo?.article.id, "older-note");
  assert.match(echo?.reason ?? "", /鲁棒性实验/);
});

test("contextual echo does not connect a LiDAR project to a novel note through generic action words", async () => {
  const stored = { ...article("novel-note", "写小说的心得技巧", "2026-09-01"), body: "建立作品与读者之间的情感契约，整理小说创作经验。" };
  const queries: string[] = [];
  const repository = {
    async listSummaries(_limit = 50, _offset = 0, query = "") {
      queries.push(query);
      return stored.body.includes(query) ? [{ ...stored, body: "" }] : [];
    },
  };
  const terms = contextualEchoTerms({
    projectTitle: "ROS2 LiDAR 无人机三维定位与跟踪",
    stageTitle: "建立",
    title: "整理",
    currentFocus: "检查",
    benefit: "完成",
  }, null);
  assert.equal(await findContextualEcho(repository, terms, "2026-09-15"), null);
  assert.ok(!queries.includes("建立"));
  assert.equal(selectContextualEcho([stored], terms, "2026-09-15"), null);
  assert.equal(selectContextualEcho([stored], ["建立", "整理"], "2026-09-15"), null);
});

test("a single short body match is insufficient evidence for a contextual echo", async () => {
  const repository = { async listSummaries() { return [article("old-note", "一个旧记录", "2026-09-01")]; } };
  assert.equal(await findContextualEcho(repository, ["反馈"], "2026-09-15"), null);
});

test("local and repository echoes use the same evidence threshold", async () => {
  const stored = { ...article("calibration", "一个旧实验", "2026-09-01"), body: "雷达标定时需要矩阵运算。" };
  const repository = {
    async listSummaries(_limit = 50, _offset = 0, query = "") {
      return stored.body.includes(query) ? [{ ...stored, body: "" }] : [];
    },
  };
  for (const terms of [["雷达"], ["雷达", "矩阵"], ["雷达标定", "雷达"]]) {
    const local = selectContextualEcho([stored], terms, "2026-09-15");
    const remote = await findContextualEcho(repository, terms, "2026-09-15");
    assert.equal(local?.article.id, remote?.article.id);
    assert.equal(local?.reason, remote?.reason);
  }
  assert.equal(selectContextualEcho([stored], ["雷达"], "2026-09-15"), null);
  assert.equal(selectContextualEcho([stored], ["雷达", "矩阵"], "2026-09-15")?.article.id, stored.id);
  assert.equal(selectContextualEcho([stored], ["标定", "定"], "2026-09-15"), null);
});

test("specific body phrases and short metadata topics still rediscover relevant notes", () => {
  const stored = { ...article("lidar", "雷达标定笔记", "2026-09-01"), body: "使用 lidar 进行实验。" };
  assert.equal(selectContextualEcho([stored], ["LiDAR"], "2026-09-15")?.article.id, stored.id);
  assert.equal(selectContextualEcho([stored], ["雷达"], "2026-09-15")?.article.id, stored.id);
});

test("echoes exclude sources, inbox notes, deleted notes and records from today", async () => {
  const stored = article("old", "雷达标定", "2026-09-01");
  const excluded = [
    { ...stored, id: "source", collection: "sources" },
    { ...stored, id: "inbox", branch: "待分类" },
    { ...stored, id: "today", updated: "2026-09-15" },
    { ...stored, id: "deleted", storage: { ...stored.storage, deletedAt: "2026-09-10" } },
  ];
  assert.equal(selectContextualEcho(excluded, ["雷达标定"], "2026-09-15"), null);
  const repository = { async listSummaries() { return excluded; } };
  assert.equal(await findContextualEcho(repository, ["雷达标定"], "2026-09-15"), null);
});

test("generic-only contexts do not search and a failed search does not prevent other matches", async () => {
  let calls = 0;
  const stored = article("lidar", "LiDAR 标定", "2026-09-01");
  const repository = {
    async listSummaries(_limit = 50, _offset = 0, query = "") {
      calls++;
      if (query === "ros2") throw new Error("search failed");
      return [stored];
    },
  };
  assert.equal(await findContextualEcho(repository, ["建立", "完成"], "2026-09-15"), null);
  assert.equal(calls, 0);
  assert.equal((await findContextualEcho(repository, ["ROS2", "LiDAR", "lidar"], "2026-09-15"))?.article.id, stored.id);
  assert.equal(calls, 2);
});

function article(id: string, title: string, updated: string): StoredArticle {
  return {
    id,
    slug: id,
    collection: "notes",
    collectionLabel: "笔记",
    title,
    created: updated,
    updated,
    branch: "学习",
    subbranch: "",
    stage: "",
    validity: "长期",
    category: "记录",
    tags: [],
    type: "记录",
    project: "",
    confidence: "",
    source: [],
    reviewDate: "",
    summary: "",
    next: "",
    body: "",
    storage: { version: 1, deviceId: "test", syncStatus: "synced", deletedAt: null },
  };
}
