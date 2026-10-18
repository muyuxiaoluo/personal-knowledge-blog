import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQuickCloseout,
  contextualEchoTerms,
  findContextualEcho,
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
