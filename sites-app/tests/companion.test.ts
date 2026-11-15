import assert from "node:assert/strict";
import test from "node:test";
import { companionReadout, companionTodayRecords, type CompanionStatus } from "../app/companion-types";
import { asabaSpeechSegments } from "../desktop/useAsabaSpeech";
import { researchIntent, researchQueries } from "../app/asaba-worker";
import { asabaIntents, careerRecruitmentBatch, careerResearchTopic } from "../app/asaba-career";

test("routes a career request without copying personal details into the public scope", () => {
  const request = "帮我准备明年的机器人岗位求职，结合我的学历和 ROS2 经历，邮箱 user@example.com";
  assert.deepEqual(asabaIntents(request), ["career"]);
  assert.equal(careerResearchTopic(request), "机器人 ROS2");
  assert.equal(careerRecruitmentBatch(request, 2026), "2027 年");
  assert.equal(careerRecruitmentBatch("2028 年秋招，机器人"), "2028 年秋招");
  assert.equal(careerRecruitmentBatch("准备 2027 年机器人岗位求职"), "2027 年");
  assert.deepEqual(asabaIntents("这个项目做到哪了，另外帮我查论文格式"), ["progress", "document"]);
  assert.deepEqual(asabaIntents("记下这个想法：机器人岗位求职准备"), ["note"]);
  assert.deepEqual(asabaIntents("帮我查查机器人岗位"), ["research"]);
  assert.equal(asabaIntents("有个想法").length > 1, true);
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
