import type { ProjectSeed } from "../project-types";

const seededAt = "2026-08-10T08:00:00.000Z";
const sourceNote = "根据现有 Codex 对话整理，内容仍需本人确认。";

export const initialProjectSeeds: ProjectSeed[] = [
  createSeed({
    id: "project-research-direction",
    title: "科研方向选择",
    outcome: "在限定的选题侦察期内形成点云研究方向地图、候选方向比较和有证据的初步判断。",
    motivation: "为硕士小论文、开题和毕业论文选择一条可完成、可延展的研究主线。",
    category: "learning",
    sortOrder: 10,
    milestone: "完成点云方向地图与候选方向比较",
    definitionOfDone: "至少比较三维目标检测、语义分割、点云增强等候选方向，并形成一页可与导师沟通的结论。",
    nextTask: "阅读三维目标检测综述并补全比较表",
    taskDetails: "继续阅读综述，补充语义分割与点云增强的任务、数据集、指标和主要难点。",
    taskBenefit: "为候选方向比较补足证据，避免只凭直觉确定研究主线。",
    actionType: "read",
  }),
  createWorkbenchRoadmapSeed(),
  createSeed({
    id: "project-shutuyidao-chapter-one",
    title: "《术途异道》持续创作",
    outcome: "持续完成真正由自己认可的小说正文，让人物、生活质感和主题在实际章节中成立。",
    motivation: "这是一部希望长期创作的作品，不只是 AI 写作工具的测试材料。",
    category: "creative",
    sortOrder: 30,
    milestone: "完成第一章作者认可的定稿",
    definitionOfDone: "第一章的核心任务、人物视角和情节结果一致，经过作者修订后愿意以它为基础继续第二章。",
    nextTask: "修订第一章最关键的场景",
    taskDetails: "回到第一章正文，选择一个最需要作者亲自改写的场景并完成一次修订。",
    taskBenefit: "用作者自己的判断建立第一章的语言与人物基调。",
    actionType: "write",
  }),
  createSeed({
    id: "project-bot-menu-shop",
    title: "QQ机器人：菜单与商店改造",
    outcome: "让菜单和商店由真实业务数据自动生成，减少新增指令或商品后的重复维护。",
    motivation: "把长期维护领域收敛为一个有完成条件的阶段项目，避免所有机器人需求同时开工。",
    category: "systems",
    sortOrder: 40,
    milestone: "完成菜单元数据与商品目录的首轮改造",
    definitionOfDone: "菜单能按身份和插件状态展示可靠说明，商店展示与实际购买规则使用同一份商品目录。",
    nextTask: "验收菜单与商店的首轮改造",
    taskDetails: "完成当前菜单与商店改造的验收，其他机器人需求先进入待选列表。",
    taskBenefit: "先关闭当前改造阶段，避免维护需求继续无边界扩张。",
    actionType: "experiment",
  }),
  createSeed({
    id: "project-ai-novel-validation",
    title: "AI Novel Generator 产品验证",
    outcome: "证明工具能帮助作者更稳定、更省力地从章节意图走到可用正文，而不只是管理大量中间状态。",
    motivation: "它服务于真实小说创作；只有直接阻塞正文的问题才值得优先修改。",
    category: "systems",
    status: "paused",
    sortOrder: 50,
    milestone: "完成三个真实章节任务的产品证明",
    definitionOfDone: "用三个不同章节任务比较生成质量、意图符合度和修改成本，并据此决定保留、删减或调整流程。",
    nextTask: "确定三个验证章节与统一评分标准",
    taskDetails: "需要恢复时，先确定三个真实章节任务和统一的人工评分标准。",
    taskBenefit: "让是否继续开发由真实创作收益决定，而不是由功能数量决定。",
    actionType: "decide",
  }),
];

function createSeed({
  id,
  title,
  outcome,
  motivation,
  category,
  status = "active",
  sortOrder,
  milestone,
  definitionOfDone,
  nextTask,
  taskDetails = "",
  taskBenefit = "",
  actionType = "organize",
}: {
  id: string;
  title: string;
  outcome: string;
  motivation: string;
  category: ProjectSeed["project"]["category"];
  status?: ProjectSeed["project"]["status"];
  sortOrder: number;
  milestone: string;
  definitionOfDone: string;
  nextTask: string;
  taskDetails?: string;
  taskBenefit?: string;
  actionType?: ProjectSeed["tasks"][number]["actionType"];
}): ProjectSeed {
  const milestoneId = `${id}-milestone-1`;
  return {
    project: {
      id,
      title,
      outcome,
      motivation,
      projectType: "main",
      parentProjectId: null,
      supportsMilestoneId: null,
      status,
      category,
      sortOrder,
      isDraft: true,
      sourceNote,
      reviewDate: "",
      completedAt: null,
      createdAt: seededAt,
      updatedAt: seededAt,
    },
    milestones: [
      {
        id: milestoneId,
        projectId: id,
        title: milestone,
        definitionOfDone,
        status: "current",
        dueDate: "",
        sortOrder: 10,
        createdAt: seededAt,
        updatedAt: seededAt,
      },
    ],
    tasks: [
      {
        id: `${id}-task-1`,
        projectId: id,
        milestoneId,
        title: nextTask,
        actionType,
        details: taskDetails || nextTask,
        benefit: taskBenefit,
        dueDate: "",
        status: "next",
        waitingFor: "",
        resumeAction: "",
        context: "anywhere",
        sortOrder: 10,
        createdAt: seededAt,
        updatedAt: seededAt,
        completedAt: null,
      },
    ],
    logs: [],
  };
}

function createWorkbenchRoadmapSeed(): ProjectSeed {
  const id = "project-life-workbench-v01";
  const roadmapUpdatedAt = "2026-08-12T02:00:00.000Z";
  const milestones: ProjectSeed["milestones"] = [
    ["information-model", "重构信息模型", "领域、项目、阶段、行动和记录的层级能够在本地数据库中稳定保存。", "completed", 10],
    ["daily-launchpad", "重做首页与推进中心", "首页不再以计时和任务堆积制造压力，行动细节默认折叠。", "completed", 20],
    ["tools-account", "整理工具入口与账户区", "常用入口可分类、置顶和删除，账户与数据操作收进侧栏。", "completed", 30],
    ["magic-theme", "完成魔法师主题", "背景、粒子和主题强度可以调节，并且不干扰阅读与编辑。", "completed", 40],
    ["real-use", "真实使用与调整", "连续使用一周，记录实际使用中第一批认知负担和流程摩擦。", "current", 50],
  ].map(([suffix, title, definitionOfDone, status, sortOrder]) => ({
    id: `${id}-milestone-${suffix}`,
    projectId: id,
    title: String(title),
    definitionOfDone: String(definitionOfDone),
    status: status as ProjectSeed["milestones"][number]["status"],
    dueDate: suffix === "real-use" ? "2026-08-19" : "2026-08-12",
    sortOrder: Number(sortOrder),
    createdAt: seededAt,
    updatedAt: roadmapUpdatedAt,
  }));
  return {
    project: {
      id,
      title: "人生攻略库",
      outcome: "形成一套能判断当下方向、按阶段推进项目，并让行动结果持续沉淀为经验的个人工作台。",
      motivation: "减少任务堆积带来的心理压力，让科研、创作与个人项目始终保留战略上下文。",
      projectType: "main",
      parentProjectId: null,
      supportsMilestoneId: null,
      status: "active",
      category: "systems",
      sortOrder: 20,
      isDraft: false,
      sourceNote: "根据本人和 Codex 的多轮讨论确认，2026-08-12 更新为阶段式路线图。",
      reviewDate: "2026-08-19",
      completedAt: null,
      createdAt: seededAt,
      updatedAt: roadmapUpdatedAt,
    },
    milestones,
    tasks: [
      {
        id: `${id}-task-1`,
        projectId: id,
        milestoneId: `${id}-milestone-real-use`,
        title: "记录一次真实使用中的流程摩擦",
        actionType: "organize",
        details: "在科研或创作中实际使用新版工作台；遇到第一处不知所措、信息过多或需要绕路的地方时，立即留下一条推进记录。",
        benefit: "让下一轮优化由真实摩擦驱动，而不是继续凭想象增加功能。",
        dueDate: "2026-08-19",
        status: "next",
        waitingFor: "",
        resumeAction: "",
        context: "anywhere",
        sortOrder: 10,
        createdAt: seededAt,
        updatedAt: roadmapUpdatedAt,
        completedAt: null,
      },
    ],
    logs: [
      {
        id: `${id}-log-roadmap-20260812`,
        projectId: id,
        body: "确认新版方向：以战略项目和阶段为核心，行动细节默认折叠；首页只保留当前推进、相关旧经验与自动形成的今日足迹。",
        createdAt: roadmapUpdatedAt,
      },
    ],
  };
}
