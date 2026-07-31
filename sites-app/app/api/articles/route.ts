import { desc, eq } from "drizzle-orm";
import seedArticles from "../../generated/articles.json";
import type { Article } from "../../types";
import { ensureDbSchema, getDb } from "../../../db";
import { articleOverrides } from "../../../db/schema";

export const dynamic = "force-dynamic";

const collectionLabels: Record<string, string> = {
  reviews: "复盘日志",
  tools: "工具评测与工作流",
  learning: "学习方法与知识整理",
  templates: "提示词与模板库",
  thoughts: "思考随笔",
  projects: "项目档案",
};

function parseJsonList(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function slugify(value: string) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || `article-${Date.now()}`;
}

function mergeRows(rows: (typeof articleOverrides.$inferSelect)[]) {
  const merged = new Map((seedArticles as Article[]).map((article) => [article.id, article]));
  for (const row of rows) {
    if (row.deleted) {
      merged.delete(row.id);
      continue;
    }

    const existing = merged.get(row.id);
    const collection = row.collection || existing?.collection || "learning";
    merged.set(row.id, {
      id: row.id,
      slug: row.slug || existing?.slug || row.id.split("/").slice(1).join("/"),
      collection,
      collectionLabel: collectionLabels[collection] || existing?.collectionLabel || "知识库",
      title: row.title || existing?.title || "未命名内容",
      created: row.created || existing?.created || "",
      updated: row.updated || existing?.updated || "",
      branch: row.branch || existing?.branch || "待分类",
      subbranch: row.subbranch || existing?.subbranch || "",
      stage: row.stage || existing?.stage || "种子",
      validity: row.validity || existing?.validity || "待验证",
      category: row.category || existing?.category || collectionLabels[collection] || "知识库",
      tags: row.tags ? parseJsonList(row.tags) : existing?.tags || [],
      type: row.type || existing?.type || "记录",
      project: row.project || existing?.project || "",
      confidence: row.confidence || existing?.confidence || "低",
      source: row.source ? parseJsonList(row.source) : existing?.source || [],
      reviewDate: row.reviewDate || existing?.reviewDate || "",
      summary: row.summary || existing?.summary || "",
      next: row.next || existing?.next || "",
      body: row.body || existing?.body || "",
    });
  }

  return [...merged.values()].sort((a, b) =>
    String(b.updated || b.created).localeCompare(String(a.updated || a.created)),
  );
}

export async function GET() {
  try {
    await ensureDbSchema();
    const rows = await getDb().select().from(articleOverrides).orderBy(desc(articleOverrides.updated));
    return Response.json({ articles: mergeRows(rows) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取知识库失败";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureDbSchema();
    const input = (await request.json()) as Partial<Article>;
    const title = String(input.title || "").trim();
    const body = String(input.body || "").trim();
    const collection = String(input.collection || "learning");
    if (!title || !body) {
      return Response.json({ error: "标题和正文不能为空" }, { status: 400 });
    }
    if (!Object.hasOwn(collectionLabels, collection)) {
      return Response.json({ error: "不支持的内容分类" }, { status: 400 });
    }

    const now = new Date().toISOString();
    const slug = input.slug || `${slugify(title)}-${Date.now()}`;
    const id = input.id || `${collection}/${slug}`;
    const values = {
      id,
      slug,
      collection,
      title,
      created: input.created || now.slice(0, 10),
      updated: now,
      branch: input.branch || "待分类",
      subbranch: input.subbranch || "",
      stage: input.stage || "种子",
      validity: input.validity || "待验证",
      category: input.category || collectionLabels[collection],
      tags: JSON.stringify(input.tags || []),
      type: input.type || "记录",
      project: input.project || "",
      confidence: input.confidence || "低",
      source: JSON.stringify(input.source || ["移动端记录"]),
      reviewDate: input.reviewDate || "",
      summary: input.summary || body.slice(0, 88),
      next: input.next ?? "",
      body,
      deleted: false,
    };
    const { id: _id, ...updates } = values;
    void _id;

    const db = getDb();
    await db
      .insert(articleOverrides)
      .values(values)
      .onConflictDoUpdate({
        target: articleOverrides.id,
        set: updates,
      });

    const [savedRow] = await db
      .select()
      .from(articleOverrides)
      .where(eq(articleOverrides.id, id))
      .limit(1);
    const savedArticle = mergeRows(savedRow ? [savedRow] : []).find(
      (article) => article.id === id,
    );

    return Response.json(
      { article: savedArticle },
      { status: input.id ? 200 : 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存内容失败";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureDbSchema();
    const input = (await request.json()) as { id?: string };
    const id = String(input.id || "").trim();
    if (!id || !id.includes("/")) {
      return Response.json({ error: "内容标识无效" }, { status: 400 });
    }

    await getDb()
      .insert(articleOverrides)
      .values({ id, deleted: true, updated: new Date().toISOString() })
      .onConflictDoUpdate({ target: articleOverrides.id, set: { deleted: true, updated: new Date().toISOString() } });
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "删除内容失败";
    return Response.json({ error: message }, { status: 500 });
  }
}
