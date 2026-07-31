import { promises as fs } from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd(), "..");
const output = path.resolve(process.cwd(), "app", "generated", "articles.json");
const collections = {
  reviews: "复盘日志",
  tools: "工具评测与工作流",
  learning: "学习方法与知识整理",
  templates: "提示词与模板库",
  thoughts: "思考随笔",
  projects: "项目档案",
};

function parseList(value = "") {
  const text = String(value).trim();
  if (!text.startsWith("[") || !text.endsWith("]")) return text ? [cleanScalar(text)] : [];
  return text.slice(1, -1).split(",").map(cleanScalar).filter(Boolean);
}

function cleanScalar(value = "") {
  return String(value).trim().replace(/\\+/g, "").replace(/^['\"]+|['\"]+$/g, "");
}

function parseMarkdown(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta = {};
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const index = line.indexOf(":");
      if (index === -1) continue;
      meta[line.slice(0, index).trim()] = cleanScalar(line.slice(index + 1));
    }
  }
  return { meta, body: markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim() };
}

const articles = [];
for (const [collection, collectionLabel] of Object.entries(collections)) {
  const dir = path.join(root, "docs", collection);
  const files = await fs.readdir(dir);
  for (const filename of files.filter((name) => name.endsWith(".md") && name !== "index.md")) {
    const slug = filename.replace(/\.md$/u, "");
    const markdown = await fs.readFile(path.join(dir, filename), "utf8");
    const { meta, body } = parseMarkdown(markdown);
    articles.push({
      id: `${collection}/${slug}`,
      slug,
      collection,
      collectionLabel,
      title: meta.title || slug,
      created: meta.created || "",
      updated: meta.updated || "",
      branch: meta.branch || "待分类",
      subbranch: meta.subbranch || "",
      stage: meta.stage || "已整理",
      validity: meta.validity || "待验证",
      category: meta.category || collectionLabel,
      tags: parseList(meta.tags),
      type: meta.type || "记录",
      project: meta.project || "",
      confidence: meta.confidence || "",
      source: parseList(meta.source),
      reviewDate: meta.reviewDate || "",
      summary: meta.summary || "",
      next: meta.next || "",
      body,
    });
  }
}

articles.sort((a, b) => String(b.updated || b.created).localeCompare(String(a.updated || a.created)));
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(articles, null, 2)}\n`, "utf8");
console.log(`Generated ${articles.length} articles.`);
