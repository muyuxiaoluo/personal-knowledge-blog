import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

const articleOverridesSchema = `
  CREATE TABLE IF NOT EXISTS article_overrides (
    id TEXT PRIMARY KEY NOT NULL,
    slug TEXT,
    collection TEXT,
    title TEXT,
    created TEXT,
    updated TEXT,
    branch TEXT,
    subbranch TEXT,
    stage TEXT,
    validity TEXT,
    category TEXT,
    tags TEXT,
    type TEXT,
    project TEXT,
    confidence TEXT,
    source TEXT,
    review_date TEXT,
    summary TEXT,
    next TEXT,
    body TEXT,
    deleted INTEGER DEFAULT 0 NOT NULL
  )
`;

let schemaReady: Promise<void> | null = null;

export async function ensureDbSchema() {
  if (!env.DB) {
    throw new Error("本地资料库尚未连接。");
  }

  schemaReady ??= env.DB
    .prepare(articleOverridesSchema)
    .run()
    .then(() => undefined)
    .catch((error: unknown) => {
      schemaReady = null;
      throw error;
    });

  await schemaReady;
}

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return drizzle(env.DB, { schema });
}
