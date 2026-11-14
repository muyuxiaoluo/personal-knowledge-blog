import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { HealthRepository } from "../app/data/health-repository";
import { FinanceRepository } from "../app/data/finance-repository";
import { PrivateRepository } from "../app/data/private-repository";
import type { SqliteDatabase } from "../app/data/sqlite-article-repository";
import { captureNative } from "./FinanceCaptureSettings";
let initialization: ReturnType<typeof initialize> | null = null;
async function initialize() {
  const database: SqliteDatabase = await Database.load("sqlite:mind-garden.db");
  database.transaction = statements => invoke("execute_sqlite_transaction", { statements });
  const health = new HealthRepository(database);
  const finance = new FinanceRepository(database);
  await health.ready(); await finance.ready();
  const privateRepository = new PrivateRepository(database);
  await privateRepository.ready();
  // Notification capture is optional; its startup must not block health/photo records.
  const captureReady = await captureNative.initialize().then(() => true).catch(() => false);
  return { health, finance, privateRepository, captureReady };
}
export function mobileRuntime() { initialization ??= initialize().catch(e => { initialization = null; throw e; }); return initialization; }
export type MobileRuntime = Awaited<ReturnType<typeof initialize>>;
