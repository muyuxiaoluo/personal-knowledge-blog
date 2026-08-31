import fs from "node:fs";
import path from "node:path";
import { createSyncServer } from "./app.mjs";
import { SyncDatabase } from "./database.mjs";

const port = Number(process.env.PORT || 8787);
const dataDir = process.env.DATA_DIR || path.resolve("data");
const adminUsername = (process.env.ADMIN_USERNAME || "owner").trim();
const adminPassword = process.env.ADMIN_PASSWORD || "";
const authSecret = process.env.AUTH_SECRET || "";
const trustProxy = process.env.TRUST_PROXY === "true";
const corsAllowedOrigins = parseCorsOrigins(process.env.CORS_ALLOWED_ORIGINS);

if (authSecret.length < 32) {
  throw new Error("AUTH_SECRET must contain at least 32 characters");
}
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
if (!adminUsername || Buffer.byteLength(adminUsername, "utf8") > 100) {
  throw new Error("ADMIN_USERNAME must contain between 1 and 100 bytes");
}

fs.mkdirSync(dataDir, { recursive: true });
const database = new SyncDatabase(path.join(dataDir, "mind-garden.sqlite3"));
database.ensureOwner(adminUsername, adminPassword);

const server = createSyncServer({
  database,
  authSecret,
  trustProxy,
  allowedOrigins: corsAllowedOrigins,
});
const maintenanceInterval = setInterval(() => runMaintenance(), 6 * 60 * 60 * 1000);
maintenanceInterval.unref();
runMaintenance();
server.listen(port, "0.0.0.0", () => {
  console.log(`mind-garden-sync listening on ${port}`);
});

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(maintenanceInterval);
  const forceClose = setTimeout(() => {
    server.closeAllConnections();
  }, 10_000);
  forceClose.unref();
  server.close(() => {
    clearTimeout(forceClose);
    database.close();
    process.exit(0);
  });
}

function runMaintenance() {
  try {
    const result = database.runMaintenance();
    if (result.compactedChanges || result.removedUserLinks || result.removedBlobs) {
      console.log("mind-garden-sync maintenance", result);
    }
  } catch (error) {
    console.error("mind-garden-sync maintenance failed", error);
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// 解析 CORS_ALLOWED_ORIGINS（逗号分隔）；未设置时返回 undefined，
// 由 createSyncServer 回退到桌面端默认白名单。
function parseCorsOrigins(value) {
  if (value === undefined || value === "") return undefined;
  const origins = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!origins.length) {
    throw new Error(
      "CORS_ALLOWED_ORIGINS 已设置但为空，请提供至少一个来源或移除该变量。",
    );
  }
  return origins;
}
