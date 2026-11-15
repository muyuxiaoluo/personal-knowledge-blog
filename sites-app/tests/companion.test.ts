import assert from "node:assert/strict";
import test from "node:test";
import { companionReadout, companionTodayRecords, type CompanionStatus } from "../app/companion-types";
import { asabaSpeechSegments } from "../desktop/useAsabaSpeech";
import { researchIntent, researchQueries } from "../app/asaba-worker";
import { careerRecruitmentBatch, careerResearchTopic } from "../app/asaba-career";
import { matchAsabaProject, routeAsabaRequest } from "../app/asaba-capabilities";

test("prepares career search terms without copying personal details into the public scope", () => {
  const request = "帮我准备明年的机器人岗位求职，结合我的学历和 ROS2 经历，邮箱 user@example.com";
  assert.equal(careerResearchTopic(request), "机器人 ROS2");
  assert.equal(careerRecruitmentBatch(request, 2026), "2027 年");
  assert.equal(careerRecruitmentBatch("2028 年秋招，机器人"), "2028 年秋招");
  assert.equal(careerRecruitmentBatch("准备 2027 年机器人岗位求职"), "2027 年");
});

test("local routing validates supported calls, arguments and clarification before dispatch", async () => {
  const requests = [
    ["记下这个想法，但暂时不要做。", { kind: "call", id: "note", args: {} }],
    ["帮我看看科研项目最近做到哪里了。", { kind: "call", id: "progress", args: { project: "科研项目" } }],
    ["浅语这个问题交给 Codex 修改。", { kind: "call", id: "delegate", args: { project: "浅语" } }],
    ["如果答辩提前了，我应该怎么办？", { kind: "call", id: "plan", args: {} }],
    ["帮我查一下最新的机器人岗位要求。", { kind: "call", id: "research", args: { topic: "机器人岗位要求" } }],
  ] as const;
  for (const [request, result] of requests) {
    const route = await routeAsabaRequest(request, async (sent, catalog) => {
      assert.equal(sent, request);
      assert.equal(catalog.progress.external, false);
      assert.equal(catalog.delegate.confirm, true);
      return result;
    });
    assert.deepEqual(route, { kind: "ready", call: { id: result.id, args: result.args } });
  }
  for (const request of ["这个项目暂时不想动。", "我还没决定是否要立项。"]) {
    const question = "你想先记下来，还是讨论一下？";
    assert.deepEqual(await routeAsabaRequest(request, async () => ({ kind: "clarify", question })), { kind: "clarify", question });
  }
  for (const invalid of [
    { kind: "call", id: "create_project", args: {} },
    { kind: "call", id: "delegate", args: { projectId: "model-chosen-id", confirm: true } },
    { kind: "call", id: "research", args: { topic: ["robotics"] } },
  ]) assert.deepEqual(await routeAsabaRequest("有个想法", async () => invalid), { kind: "manual", reason: "invalid" });
  assert.deepEqual(await routeAsabaRequest("有个想法", async () => { throw Error("offline"); }), { kind: "manual", reason: "unavailable" });
  const projects = [{ id: "1", title: "科研项目 A" }, { id: "2", title: "科研项目 B" }, { id: "3", title: "草稿", isDraft: true }];
  assert.equal(matchAsabaProject(projects, "科研项目"), undefined);
  assert.equal(matchAsabaProject(projects, "科研项目 ａ")?.id, "1");
  assert.equal(matchAsabaProject(projects, "草稿"), undefined);
});

test("routes explicit public research without treating project progress as a web search", () => {
  assert.equal(researchIntent("帮我查一下科研项目进度"), null);
  assert.deepEqual(researchIntent("浅羽，帮我查查定位和 ROS2 岗位"), { topic: "定位和 ROS2 岗位", requiresReview: false });
  assert.deepEqual(researchIntent("帮我调研结合我的学历的岗位"), { topic: "", requiresReview: true });
  assert.equal(researchQueries("定位 SLAM 和机器人 ROS2 岗位").length, 4);
  assert.ok(researchQueries("岗位".repeat(200)).every(query => Array.from(query).length <= 128));
});

test("work records use the local calendar day and reject invalid timestamps", () => {
  const records = ["2026-11-09T10:00:00+08:00", "2026-11-08T10:00:00+08:00", "bad"].map((occurredAt, index) => ({id:String(index),threadId:"t",title:"a",projectPath:"D:/p",occurredAt,updatedAt:occurredAt,status:"completed",text:"x",limited:false}));
  const expectedDay = new Date(records[0].occurredAt).toLocaleDateString("en-CA");
  assert.deepEqual(companionTodayRecords(records, expectedDay).map(record => record.id), ["0"]);
});

test("news readout reads every morning item and only keyword-matched AI titles", () => {
  const status = {context:{brief:{date:"2026-11-09",news:["消息一","消息二"]},news:[{title:"未命中关注词的消息",summary:"仍然有意思",url:"https://example.com"},{title:"ROS2新进展",summary:"这一段无需朗读",url:"https://example.com",matched:true}]}} as CompanionStatus;
  const result = companionReadout(status);
  assert.match(result,/消息一/); assert.match(result,/消息二/); assert.match(result,/ROS2新进展/);
  assert.doesNotMatch(result,/未命中关注词|仍然有意思|这一段无需朗读/);
  assert.doesNotMatch(result,/https/);
});

test("Qianyu speech keeps sentence boundaries and limits long clauses to 28 characters", () => {
  const long = "羽".repeat(61) + "。";
  const input = "早上好，[打开资料](https://example.com)。" + long + " 今天见！";
  const parts = asabaSpeechSegments(input);
  assert.equal(parts.join(""), "早上好，打开资料。" + long + "今天见！");
  assert.ok(parts.every(part => Array.from(part).length <= 28));
  assert.deepEqual(asabaSpeechSegments("第一句话。第二句话！第三句话？"), ["第一句话。", "第二句话！", "第三句话？"]);
  assert.deepEqual(asabaSpeechSegments("## 今天\n- **完成修复**\n- `ROS2` 测试通过。"), ["今天。", "完成修复。", "ROS2 测试通过。"]);
});
