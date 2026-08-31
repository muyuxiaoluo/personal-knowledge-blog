import { invoke } from "@tauri-apps/api/core";
import type { ArticleRepository } from "./article-repository";
import type { SqliteDatabase } from "./sqlite-article-repository";

const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
const KEEP_ANIMATED_GIF_BYTES = 5 * 1024 * 1024;
const SMALL_IMAGE_BYTES = 350 * 1024;

export type AttachmentManifest = {
  id: string;
  originalHash: string;
  previewHash: string;
  originalMimeType: string;
  previewMimeType: string;
  fileName: string;
  width: number;
  height: number;
  originalBytes: number;
  previewBytes: number;
  animated: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

type AttachmentRow = {
  id: string;
  original_hash: string;
  preview_hash: string;
  original_mime_type: string;
  preview_mime_type: string;
  file_name: string;
  width: number;
  height: number;
  original_bytes: number;
  preview_bytes: number;
  animated: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type StoredBlob = {
  hash: string;
  mimeType: string;
  byteLength: number;
  width: number;
  height: number;
  animated: boolean;
};

const attachmentMigrations = [
  `CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY NOT NULL,
    original_hash TEXT NOT NULL UNIQUE,
    preview_hash TEXT NOT NULL,
    original_mime_type TEXT NOT NULL,
    preview_mime_type TEXT NOT NULL,
    file_name TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    original_bytes INTEGER NOT NULL,
    preview_bytes INTEGER NOT NULL,
    animated INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    device_id TEXT NOT NULL DEFAULT '',
    sync_status TEXT NOT NULL DEFAULT 'pending',
    deleted_at TEXT,
    orphaned_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS article_attachment_refs (
    article_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(article_id, attachment_id),
    FOREIGN KEY(article_id) REFERENCES articles(id) ON DELETE CASCADE,
    FOREIGN KEY(attachment_id) REFERENCES attachments(id) ON DELETE RESTRICT
  )`,
  `CREATE TABLE IF NOT EXISTS attachment_migration_errors (
    article_id TEXT PRIMARY KEY NOT NULL,
    message TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS attachment_gc_queue (
    hash TEXT NOT NULL,
    variant TEXT NOT NULL CHECK(variant IN ('original', 'preview')),
    eligible_at TEXT NOT NULL,
    PRIMARY KEY(hash, variant)
  )`,
  `CREATE TRIGGER IF NOT EXISTS attachments_queue_gc BEFORE DELETE ON attachments BEGIN
    INSERT INTO attachment_gc_queue(hash, variant, eligible_at)
    VALUES(OLD.original_hash, 'original', datetime('now'))
    ON CONFLICT(hash, variant) DO UPDATE SET eligible_at = excluded.eligible_at;
    INSERT INTO attachment_gc_queue(hash, variant, eligible_at)
    VALUES(OLD.preview_hash, 'preview', datetime('now'))
    ON CONFLICT(hash, variant) DO UPDATE SET eligible_at = excluded.eligible_at;
  END`,
  `CREATE TRIGGER IF NOT EXISTS attachment_refs_mark_orphan AFTER DELETE ON article_attachment_refs BEGIN
    UPDATE attachments SET orphaned_at = datetime('now')
    WHERE id = OLD.attachment_id
      AND NOT EXISTS (
        SELECT 1 FROM article_attachment_refs refs WHERE refs.attachment_id = OLD.attachment_id
      );
  END`,
  "CREATE INDEX IF NOT EXISTS attachment_refs_attachment_idx ON article_attachment_refs(attachment_id)",
  "CREATE INDEX IF NOT EXISTS attachments_sync_idx ON attachments(sync_status, updated_at)",
  "CREATE INDEX IF NOT EXISTS attachments_orphan_idx ON attachments(orphaned_at)",
] as const;

function rowToManifest(row: AttachmentRow): AttachmentManifest {
  return {
    id: row.id,
    originalHash: row.original_hash,
    previewHash: row.preview_hash,
    originalMimeType: row.original_mime_type,
    previewMimeType: row.preview_mime_type,
    fileName: row.file_name,
    width: Number(row.width),
    height: Number(row.height),
    originalBytes: Number(row.original_bytes),
    previewBytes: Number(row.preview_bytes),
    animated: Boolean(row.animated),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function normalizeFileName(value: string) {
  return (value.trim() || "image")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .slice(0, 180);
}

function attachmentId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function supportedImageType(type: string) {
  return /^image\/(?:png|jpe?g|gif|webp|bmp)$/i.test(type);
}

function attachmentIds(body: string) {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(/attachment:\/\/([a-z\d][a-z\d-]{7,127})/gi)) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      ids.push(match[1]);
    }
  }
  return ids;
}

async function storeBlob(blob: Blob, variant: "original" | "preview") {
  return invoke<StoredBlob>(
    "attachment_store_blob",
    new Uint8Array(await blob.arrayBuffer()),
    { headers: { "x-attachment-variant": variant } },
  );
}

async function decodeImage(file: Blob) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    if (!bitmap.width || !bitmap.height) throw new Error("图片尺寸无效");
    return bitmap;
  } catch (error) {
    throw new Error(error instanceof Error ? `图片已损坏或无法解码：${error.message}` : "图片已损坏或无法解码");
  }
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("无法生成图片展示版")),
      "image/webp",
      quality,
    );
  });
}

async function makePreview(
  file: File | Blob,
  type: string,
  width: number,
  height: number,
) {
  const screenshotLike = /image\/(?:png|bmp)/i.test(type);
  const maxSide = screenshotLike ? 2400 : 1920;
  const targetBytes = screenshotLike ? 1024 * 1024 : 600 * 1024;
  if (
    file.size <= SMALL_IMAGE_BYTES
    && Math.max(width, height) <= maxSide
    && type !== "image/bmp"
  ) {
    return file;
  }

  const bitmap = await decodeImage(file);
  try {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    let renderWidth = Math.max(1, Math.round(width * scale));
    let renderHeight = Math.max(1, Math.round(height * scale));
    let quality = screenshotLike ? 1 : 0.82;
    let result: Blob | null = null;

    for (let attempt = 0; attempt < 7; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = renderWidth;
      canvas.height = renderHeight;
      const context = canvas.getContext("2d", { alpha: true });
      if (!context) throw new Error("当前设备无法处理图片");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, renderWidth, renderHeight);
      result = await canvasBlob(canvas, quality);
      canvas.width = 1;
      canvas.height = 1;
      if (result.size <= targetBytes) break;
      if (quality > 0.72) quality = Math.max(0.72, quality - (screenshotLike ? 0.05 : 0.07));
      else {
        renderWidth = Math.max(1, Math.round(renderWidth * 0.86));
        renderHeight = Math.max(1, Math.round(renderHeight * 0.86));
      }
    }
    if (!result) throw new Error("无法生成图片展示版");
    return result;
  } finally {
    bitmap.close();
  }
}

export class AttachmentRepository {
  private initialization: Promise<void> | null = null;
  private manifestCache = new Map<string, AttachmentManifest | null>();
  private remoteLoader: ((manifest: AttachmentManifest, original: boolean) => Promise<void>) | null = null;

  constructor(private readonly database: SqliteDatabase) {}

  setRemoteLoader(loader: ((manifest: AttachmentManifest, original: boolean) => Promise<void>) | null) {
    this.remoteLoader = loader;
  }

  async initialize() {
    this.initialization ??= (async () => {
      for (const statement of attachmentMigrations) await this.database.execute(statement);
      const columns = await this.database.select<{ name: string }>("PRAGMA table_info(attachments)");
      if (!columns.some((column) => column.name === "ever_referenced")) {
        await this.database.execute("ALTER TABLE attachments ADD COLUMN ever_referenced INTEGER NOT NULL DEFAULT 0");
      }
    })().catch((error) => {
      this.initialization = null;
      throw error;
    });
    await this.initialization;
  }

  async importImage(file: File | Blob, fileName = "image"): Promise<AttachmentManifest> {
    await this.initialize();
    const type = file.type.toLowerCase();
    if (!supportedImageType(type)) throw new Error("暂不支持该图片格式，请使用 PNG、JPG、GIF、WebP 或 BMP。");
    if (!file.size || file.size > MAX_ORIGINAL_BYTES) throw new Error("单张原图不能超过 25 MiB。");

    const bitmap = await decodeImage(file);
    const width = bitmap.width;
    const height = bitmap.height;
    bitmap.close();
    if (width * height > MAX_PIXELS) throw new Error("图片不能超过 4000 万像素。");

    const original = await storeBlob(file, "original");
    const existing = await this.database.select<AttachmentRow>(
      "SELECT * FROM attachments WHERE original_hash = ? AND deleted_at IS NULL LIMIT 1",
      [original.hash],
    );
    if (existing[0]) {
      const manifest = rowToManifest(existing[0]);
      this.manifestCache.set(manifest.id, manifest);
      return manifest;
    }

    const keepAnimated = type === "image/gif" && file.size <= KEEP_ANIMATED_GIF_BYTES;
    const previewBlob = keepAnimated ? file : await makePreview(file, type, width, height);
    const preview = await storeBlob(previewBlob, "preview");
    const id = attachmentId();
    const now = new Date().toISOString();
    await this.database.execute(
      `INSERT INTO attachments(
        id, original_hash, preview_hash, original_mime_type, preview_mime_type,
        file_name, width, height, original_bytes, preview_bytes, animated,
        created_at, updated_at, version, sync_status, orphaned_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?)`,
      [
        id,
        original.hash,
        preview.hash,
        original.mimeType,
        preview.mimeType,
        normalizeFileName(fileName),
        width,
        height,
        original.byteLength,
        preview.byteLength,
        keepAnimated ? 1 : 0,
        now,
        now,
        now,
      ],
    );
    const manifest: AttachmentManifest = {
      id,
      originalHash: original.hash,
      previewHash: preview.hash,
      originalMimeType: original.mimeType,
      previewMimeType: preview.mimeType,
      fileName: normalizeFileName(fileName),
      width,
      height,
      originalBytes: original.byteLength,
      previewBytes: preview.byteLength,
      animated: keepAnimated,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.manifestCache.set(id, manifest);
    return manifest;
  }

  async get(id: string): Promise<AttachmentManifest | null> {
    await this.initialize();
    if (this.manifestCache.has(id)) return this.manifestCache.get(id) ?? null;
    const rows = await this.database.select<AttachmentRow>(
      "SELECT * FROM attachments WHERE id = ? AND deleted_at IS NULL LIMIT 1",
      [id],
    );
    const manifest = rows[0] ? rowToManifest(rows[0]) : null;
    this.manifestCache.set(id, manifest);
    return manifest;
  }

  async read(id: string, original = false) {
    const manifest = await this.get(id);
    if (!manifest) throw new Error("附件清单不存在");
    const hash = original ? manifest.originalHash : manifest.previewHash;
    const variant = original ? "original" : "preview";
    let response: ArrayBuffer | Uint8Array;
    try {
      response = await invoke<ArrayBuffer | Uint8Array>("attachment_read_blob", { hash, variant });
    } catch (error) {
      if (!this.remoteLoader) throw error;
      await this.remoteLoader(manifest, original);
      response = await invoke<ArrayBuffer | Uint8Array>("attachment_read_blob", { hash, variant });
    }
    const bytes = response instanceof Uint8Array ? response : new Uint8Array(response);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Blob([copy.buffer], { type: original ? manifest.originalMimeType : manifest.previewMimeType });
  }

  async uploadForSync(serverUrl: string, accessToken: string, manifest: AttachmentManifest) {
    const blobs = [
      { hash: manifest.previewHash, variant: "preview", mimeType: manifest.previewMimeType },
      { hash: manifest.originalHash, variant: "original", mimeType: manifest.originalMimeType },
    ] as const;
    let uploaded = 0;
    const seen = new Set<string>();
    for (const blob of blobs) {
      if (seen.has(blob.hash)) continue;
      seen.add(blob.hash);
      if (await invoke<boolean>("attachment_upload_blob", {
        serverUrl,
        accessToken,
        hash: blob.hash,
        variant: blob.variant,
        mimeType: blob.mimeType,
      })) uploaded += 1;
    }
    return uploaded;
  }

  async downloadForSync(
    serverUrl: string,
    accessToken: string,
    manifest: AttachmentManifest,
    original = false,
  ) {
    return invoke<boolean>("attachment_download_blob", {
      serverUrl,
      accessToken,
      hash: original ? manifest.originalHash : manifest.previewHash,
      variant: original ? "original" : "preview",
    });
  }

  async replaceArticleReferences(articleId: string, body: string) {
    await this.initialize();
    const ids = attachmentIds(body);
    const now = new Date().toISOString();
    const statements = [
      { sql: "DELETE FROM article_attachment_refs WHERE article_id = ?", bindValues: [articleId] },
      ...ids.map((id, ordinal) => ({
        sql: `INSERT INTO article_attachment_refs(article_id, attachment_id, ordinal, created_at)
              SELECT ?, id, ?, ? FROM attachments WHERE id = ? AND deleted_at IS NULL`,
        bindValues: [articleId, ordinal, now, id],
      })),
      ...ids.map((id) => ({
        sql: "UPDATE attachments SET orphaned_at = NULL, ever_referenced = 1 WHERE id = ?",
        bindValues: [id],
      })),
      {
        sql: `UPDATE attachments SET orphaned_at = ?
              WHERE deleted_at IS NULL AND orphaned_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM article_attachment_refs refs WHERE refs.attachment_id = attachments.id)`,
        bindValues: [now],
      },
    ];
    if (this.database.transaction) await this.database.transaction(statements);
    else {
      for (const statement of statements) await this.database.execute(statement.sql, statement.bindValues);
    }
  }

  async cleanupAbandonedDrafts() {
    await this.initialize();
    await this.database.execute(
      `UPDATE attachments SET deleted_at = COALESCE(deleted_at, datetime('now')), updated_at = datetime('now')
       WHERE ever_referenced = 1 AND deleted_at IS NULL AND orphaned_at IS NOT NULL
         AND datetime(orphaned_at) <= datetime('now', '-1 day')
         AND NOT EXISTS (
           SELECT 1 FROM article_attachment_refs refs WHERE refs.attachment_id = attachments.id
         )`,
    );
    const candidates = await this.database.select<Pick<AttachmentRow, "id" | "original_hash" | "preview_hash">>(
      `SELECT id, original_hash, preview_hash FROM attachments
       WHERE ever_referenced = 0 AND orphaned_at IS NOT NULL
         AND datetime(orphaned_at) <= datetime('now', '-1 day')
         AND NOT EXISTS (
           SELECT 1 FROM article_attachment_refs refs WHERE refs.attachment_id = attachments.id
         )`,
    );
    for (const candidate of candidates) {
      await this.database.execute("DELETE FROM attachments WHERE id = ? AND ever_referenced = 0", [candidate.id]);
      this.manifestCache.delete(candidate.id);
    }
    await this.cleanupGarbageQueue();
    return candidates.length;
  }

  async cleanupGarbageQueue() {
    await this.initialize();
    const queued = await this.database.select<{ hash: string; variant: "original" | "preview" }>(
      "SELECT hash, variant FROM attachment_gc_queue WHERE eligible_at <= datetime('now') LIMIT 200",
    );
    for (const item of queued) {
      const column = item.variant === "original" ? "original_hash" : "preview_hash";
      const references = await this.database.select<{ count: number }>(
        `SELECT COUNT(*) AS count FROM attachments WHERE ${column} = ?`,
        [item.hash],
      );
      if (Number(references[0]?.count ?? 0) === 0) {
        try {
          await invoke("attachment_delete_blob", { hash: item.hash, variant: item.variant });
        } catch {
          continue;
        }
      }
      await this.database.execute(
        "DELETE FROM attachment_gc_queue WHERE hash = ? AND variant = ?",
        [item.hash, item.variant],
      );
    }
  }

  async recordMigrationError(articleId: string, error: unknown) {
    await this.initialize();
    const message = error instanceof Error ? error.message : String(error);
    await this.database.execute(
      `INSERT INTO attachment_migration_errors(article_id, message, updated_at) VALUES(?, ?, ?)
       ON CONFLICT(article_id) DO UPDATE SET message = excluded.message, updated_at = excluded.updated_at`,
      [articleId, message.slice(0, 1000), new Date().toISOString()],
    );
  }

  async clearMigrationError(articleId: string) {
    await this.initialize();
    await this.database.execute("DELETE FROM attachment_migration_errors WHERE article_id = ?", [articleId]);
  }
}

export function attachmentManifestFromSyncPayload(
  id: string,
  payload: Record<string, unknown>,
): AttachmentManifest | null {
  const text = (key: string) => typeof payload[key] === "string" ? payload[key] as string : "";
  const number = (key: string) => Number.isFinite(Number(payload[key])) ? Number(payload[key]) : 0;
  const originalHash = text("original_hash").toLowerCase();
  const previewHash = text("preview_hash").toLowerCase();
  if (!/^[a-f\d]{64}$/.test(originalHash) || !/^[a-f\d]{64}$/.test(previewHash)) return null;
  const originalMimeType = text("original_mime_type");
  const previewMimeType = text("preview_mime_type");
  if (!supportedImageType(originalMimeType) || !supportedImageType(previewMimeType)) return null;
  return {
    id,
    originalHash,
    previewHash,
    originalMimeType,
    previewMimeType,
    fileName: text("file_name") || "image",
    width: number("width"),
    height: number("height"),
    originalBytes: number("original_bytes"),
    previewBytes: number("preview_bytes"),
    animated: Boolean(payload.animated),
    createdAt: text("created_at"),
    updatedAt: text("updated_at"),
    deletedAt: text("deleted_at") || null,
  };
}

export function attachmentUri(id: string) {
  return `attachment://${id}`;
}

export function attachmentIdFromUri(value: string) {
  return /^attachment:\/\/([a-z\d][a-z\d-]{7,127})$/i.exec(value)?.[1] ?? null;
}

const legacyInlineImagePattern = /data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[a-z\d+/=]+/gi;

export function legacyInlineImages(body: string) {
  return Array.from(new Set(body.match(legacyInlineImagePattern) ?? []));
}

function blobFromDataUrl(value: string) {
  const match = /^data:(image\/(?:png|jpe?g|gif|webp|bmp));base64,([a-z\d+/=]+)$/i.exec(value);
  if (!match) throw new Error("旧图片数据格式无效");
  let decoded: string;
  try {
    decoded = atob(match[2]);
  } catch {
    throw new Error("旧图片 Base64 数据已损坏");
  }
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return new Blob([bytes.buffer], { type: match[1].toLowerCase() });
}

export type AttachmentMigrationResult = {
  migratedArticles: number;
  migratedImages: number;
  failedArticles: number;
};

/** Each article is rewritten only after all of its legacy images have been safely imported. */
export async function migrateLegacyInlineImages(
  articles: ArticleRepository,
  attachments: AttachmentRepository,
  beforeMigration?: () => Promise<void>,
): Promise<AttachmentMigrationResult> {
  const result: AttachmentMigrationResult = {
    migratedArticles: 0,
    migratedImages: 0,
    failedArticles: 0,
  };
  const storedArticles = await articles.list();
  if (storedArticles.some((article) => legacyInlineImages(article.body).length)) {
    await beforeMigration?.();
  }
  for (const article of storedArticles) {
    const images = legacyInlineImages(article.body);
    if (!images.length) continue;
    try {
      let body = article.body;
      for (let index = 0; index < images.length; index += 1) {
        const image = images[index];
        const manifest = await attachments.importImage(
          blobFromDataUrl(image),
          `legacy-inline-${index + 1}`,
        );
        body = body.split(image).join(attachmentUri(manifest.id));
        result.migratedImages += 1;
      }
      const saved = await articles.save({ ...article, body });
      await attachments.replaceArticleReferences(saved.id, saved.body);
      await attachments.clearMigrationError(article.id);
      result.migratedArticles += 1;
    } catch (error) {
      result.failedArticles += 1;
      await attachments.recordMigrationError(article.id, error).catch(() => undefined);
    }
  }
  return result;
}
