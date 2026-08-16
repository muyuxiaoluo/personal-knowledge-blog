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

const server = createSyncServer({ database, authSecret, trustProxy });
server.listen(port, "0.0.0.0", () => {
  console.log(`mind-garden-sync listening on ${port}`);
});

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
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

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
