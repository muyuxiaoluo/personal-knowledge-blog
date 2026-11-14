import type { AiConversation, AiMessage, AiRestoreState, AiRole } from "../ai-types";
import type { SqliteDatabase } from "./sqlite-article-repository";
import type { GlobalPlanningHistoryEntry, GlobalPlanningRecord } from "../global-planning";

export type PlanningHistoryRepository = Pick<SqliteAiRepository, "listPlanningHistory" | "getPlanningRecord" | "savePlanningRecord">;

type ConversationRow = {
  id: string;
  provider: "deepseek";
  title: string;
  remote_ref: string;
  pinned: number;
  restore_state: AiRestoreState;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  role: AiRole;
  content: string;
  reasoning: string;
  sequence_index: number;
  created_at: string;
};

const retentionMs = 30 * 24 * 60 * 60 * 1000;

export class SqliteAiRepository {
  private initialization: Promise<void> | null = null;
  private planningInitialization: Promise<void> | null = null;

  constructor(
    private readonly database: SqliteDatabase,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async initialize() {
    this.initialization ??= (async () => {
      await this.database.execute(`CREATE TABLE IF NOT EXISTS ai_conversations (
        id TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL,
        title TEXT NOT NULL,
        remote_ref TEXT NOT NULL DEFAULT '',
        pinned INTEGER NOT NULL DEFAULT 0,
        restore_state TEXT NOT NULL DEFAULT 'local',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT
      )`);
      await this.database.execute(`CREATE TABLE IF NOT EXISTS ai_messages (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        reasoning TEXT NOT NULL DEFAULT '',
        sequence_index INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
      )`);
      const messageColumns = await this.database.select<{ name: string }>("PRAGMA table_info(ai_messages)");
      if (!messageColumns.some((column) => column.name === "reasoning")) {
        await this.database.execute("ALTER TABLE ai_messages ADD COLUMN reasoning TEXT NOT NULL DEFAULT ''");
      }
      await this.database.execute("CREATE INDEX IF NOT EXISTS idx_ai_conversations_updated ON ai_conversations(pinned DESC, updated_at DESC)");
      await this.database.execute("CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation ON ai_messages(conversation_id, sequence_index)");
    })().catch((error) => {
      this.initialization = null;
      throw error;
    });
    await this.initialization;
  }

  private async initializePlanningHistory() {
    this.planningInitialization ??= (async () => {
      await this.initialize();
      // History is opened after startup; keep its new schema out of parallel FTS initialization.
      await this.database.execute(`CREATE TABLE IF NOT EXISTS ai_planning_history (
        id TEXT PRIMARY KEY NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);
      await this.database.execute("CREATE INDEX IF NOT EXISTS idx_ai_planning_history_created ON ai_planning_history(created_at DESC, id DESC)");
    })().catch((error) => { this.planningInitialization = null; throw error; });
    await this.planningInitialization;
  }

  async savePlanningRecord(record: GlobalPlanningRecord): Promise<void> {
    await this.initializePlanningHistory();
    await this.database.execute(
      `INSERT INTO ai_planning_history(id, payload_json, created_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json`,
      [record.id, JSON.stringify(record), record.createdAt],
    );
  }

  async listPlanningHistory(limit = 20, offset = 0): Promise<GlobalPlanningHistoryEntry[]> {
    await this.initializePlanningHistory();
    const rows = await this.database.select<{ payload_json: string }>(
      "SELECT payload_json FROM ai_planning_history ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
      [Math.min(100, Math.max(1, Math.floor(limit))), Math.max(0, Math.floor(offset))],
    );
    return rows.map((row) => {
      const record = JSON.parse(row.payload_json) as GlobalPlanningRecord;
      return { id: record.id, createdAt: record.createdAt, request: record.request, model: record.model, summary: record.proposal.summary };
    });
  }

  async getPlanningRecord(id: string): Promise<GlobalPlanningRecord | null> {
    await this.initializePlanningHistory();
    const rows = await this.database.select<{ payload_json: string }>("SELECT payload_json FROM ai_planning_history WHERE id = ?", [id]);
    return rows[0] ? JSON.parse(rows[0].payload_json) as GlobalPlanningRecord : null;
  }

  async cleanupExpired(): Promise<number> {
    await this.initialize();
    const now = this.clock().toISOString();
    await this.database.execute(
      "DELETE FROM ai_messages WHERE conversation_id IN (SELECT id FROM ai_conversations WHERE pinned = 0 AND expires_at IS NOT NULL AND expires_at < ?)",
      [now],
    );
    const result = await this.database.execute(
      "DELETE FROM ai_conversations WHERE pinned = 0 AND expires_at IS NOT NULL AND expires_at < ?",
      [now],
    );
    return result.rowsAffected ?? 0;
  }

  async listConversations(): Promise<AiConversation[]> {
    await this.initialize();
    const rows = await this.database.select<ConversationRow>(
      "SELECT * FROM ai_conversations ORDER BY pinned DESC, updated_at DESC",
    );
    return rows.map(rowToConversation);
  }

  async listMessages(conversationId: string): Promise<AiMessage[]> {
    await this.initialize();
    const rows = await this.database.select<MessageRow>(
      "SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY sequence_index ASC",
      [conversationId],
    );
    return rows.map(rowToMessage);
  }

  async createConversation(title = "新对话"): Promise<AiConversation> {
    await this.initialize();
    const now = this.clock();
    const conversation: AiConversation = {
      id: `ai-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      provider: "deepseek",
      title: normalizeTitle(title),
      remoteRef: "",
      pinned: false,
      restoreState: "local",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + retentionMs).toISOString(),
    };
    await this.database.execute(
      `INSERT INTO ai_conversations(id, provider, title, remote_ref, pinned, restore_state, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [conversation.id, conversation.provider, conversation.title, conversation.remoteRef, 0, conversation.restoreState, conversation.createdAt, conversation.updatedAt, conversation.expiresAt],
    );
    return conversation;
  }

  async addMessage(conversationId: string, role: AiRole, content: string, reasoning = ""): Promise<AiMessage> {
    await this.initialize();
    const body = content.trim();
    if (!body) throw new Error("消息内容不能为空");
    const sequenceRows = await this.database.select<{ next_sequence: number }>(
      "SELECT COALESCE(MAX(sequence_index), -1) + 1 AS next_sequence FROM ai_messages WHERE conversation_id = ?",
      [conversationId],
    );
    const now = this.clock();
    const message: AiMessage = {
      id: `msg-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      conversationId,
      role,
      content: body,
      reasoning: role === "assistant" ? reasoning.trim() : "",
      sequence: Number(sequenceRows[0]?.next_sequence ?? 0),
      createdAt: now.toISOString(),
    };
    await this.database.execute(
      "INSERT INTO ai_messages(id, conversation_id, role, content, reasoning, sequence_index, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [message.id, message.conversationId, message.role, message.content, message.reasoning, message.sequence, message.createdAt],
    );
    const titleSql = role === "user" && message.sequence === 0 ? ", title = ?" : "";
    const titleValues = role === "user" && message.sequence === 0 ? [normalizeTitle(body)] : [];
    await this.database.execute(
      `UPDATE ai_conversations SET updated_at = ?, expires_at = CASE WHEN pinned = 1 THEN NULL ELSE ? END${titleSql} WHERE id = ?`,
      [now.toISOString(), new Date(now.getTime() + retentionMs).toISOString(), ...titleValues, conversationId],
    );
    return message;
  }

  async updateRemoteState(id: string, remoteRef: string, restoreState: AiRestoreState): Promise<void> {
    await this.initialize();
    await this.database.execute(
      "UPDATE ai_conversations SET remote_ref = ?, restore_state = ?, updated_at = ? WHERE id = ?",
      [remoteRef, restoreState, this.clock().toISOString(), id],
    );
  }

  async updateMessageContent(messageId: string, content: string, reasoning?: string): Promise<void> {
    await this.initialize();
    const body = content.trim();
    if (!body) throw new Error("消息内容不能为空");
    const now = this.clock();
    if (reasoning === undefined) {
      await this.database.execute("UPDATE ai_messages SET content = ? WHERE id = ?", [body, messageId]);
    } else {
      await this.database.execute("UPDATE ai_messages SET content = ?, reasoning = ? WHERE id = ?", [body, reasoning.trim(), messageId]);
    }
    await this.database.execute(
      `UPDATE ai_conversations
       SET updated_at = ?, expires_at = CASE WHEN pinned = 1 THEN NULL ELSE ? END
       WHERE id = (SELECT conversation_id FROM ai_messages WHERE id = ?)`,
      [now.toISOString(), new Date(now.getTime() + retentionMs).toISOString(), messageId],
    );
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    await this.initialize();
    const now = this.clock();
    await this.database.execute(
      "UPDATE ai_conversations SET pinned = ?, expires_at = ?, updated_at = ? WHERE id = ?",
      [pinned ? 1 : 0, pinned ? null : new Date(now.getTime() + retentionMs).toISOString(), now.toISOString(), id],
    );
  }

  async deleteConversation(id: string): Promise<void> {
    await this.initialize();
    await this.database.execute("DELETE FROM ai_messages WHERE conversation_id = ?", [id]);
    await this.database.execute("DELETE FROM ai_conversations WHERE id = ?", [id]);
  }
}

function normalizeTitle(value: string) {
  const title = value.replace(/\s+/g, " ").trim().slice(0, 32);
  return title || "新对话";
}

function rowToConversation(row: ConversationRow): AiConversation {
  return {
    id: row.id,
    provider: row.provider,
    title: row.title,
    remoteRef: row.remote_ref,
    pinned: Boolean(row.pinned),
    restoreState: row.restore_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function rowToMessage(row: MessageRow): AiMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    reasoning: row.reasoning || "",
    sequence: Number(row.sequence_index),
    createdAt: row.created_at,
  };
}
