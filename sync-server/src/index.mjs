import fs from "node:fs";
import path from "node:path";
import { createSyncServer } from "./app.mjs";
import { SyncDatabase } from "./database.mjs";

const port = Number(process.env.PORT || 8787);
const dataDir = process.env.DATA_DIR || path.resolve("data");
const adminUsername = process.env.ADMIN_USERNAME || "owner";
const adminPassword = process.env.ADMIN_PASSWORD || "";
const authSecret = process.env.AUTH_SECRET || "";

if (authSecret.length < 32) {
  throw new Error("AUTH_SECRET must contain at least 32 characters");
}

fs.mkdirSync(dataDir, { recursive: true });
const database = new SyncDatabase(path.join(dataDir, "mind-garden.sqlite3"));
database.ensureOwner(adminUsername, adminPassword);

const server = createSyncServer({ database, authSecret });
server.listen(port, "0.0.0.0", () => {
  console.log(`mind-garden-sync listening on ${port}`);
});

function shutdown() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
