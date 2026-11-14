import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

if (process.platform !== "win32" || !process.env.LOCALAPPDATA) {
  throw new Error("This launcher requires Windows and LOCALAPPDATA.");
}

const site = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const cli = require.resolve("@tauri-apps/cli/tauri.js");
const debuggerPath = process.env.WORKBENCH_CDB_PATH
  ?? path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Windows Kits", "10", "Debuggers", "x64", "cdb.exe");
if (!existsSync(debuggerPath)) {
  throw new Error("Crash capture requires cdb.exe from Debugging Tools for Windows. Install it or set WORKBENCH_CDB_PATH.");
}
const root = path.join(process.env.LOCALAPPDATA, "com.muyuxiaoluo.life-strategy-library.dev", "developer-logs");
const sessionName = `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`;
const session = path.join(root, sessionName);
mkdirSync(session, { recursive: true });

const expiry = Date.now() - 14 * 24 * 60 * 60 * 1000;
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-\d+$/.test(entry.name)) continue;
  const startedAt = Date.parse(entry.name.slice(0, 13) + ":" + entry.name.slice(14, 16) + ":" + entry.name.slice(17, 24));
  if (startedAt < expiry) {
    try { rmSync(path.join(root, entry.name), { recursive: true }); }
    catch (error) { console.warn(`[developer] Could not remove expired logs: ${error.message}`); }
  }
}

const limit = 4 * 1024 * 1024;
let part = 0;
let bytes = 0;
const openPart = () => openSync(path.join(session, `terminal-${part}.log`), "w");
let file = openPart();

function record(source, line) {
  const clean = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const entry = Buffer.from(`${new Date().toISOString()} [${source}] ${clean}\n`);
  if (bytes + entry.length > limit && bytes > 0) {
    closeSync(file);
    part = (part + 1) % 4;
    file = openPart();
    bytes = 0;
  }
  bytes += writeSync(file, entry);
  (source === "stderr" ? process.stderr : process.stdout).write(line + "\n");
}

record("launcher", `Developer logs: ${session}`);
record("launcher", `Native crash capture: ${debuggerPath}`);
const runner = "node ../scripts/run-development-app.mjs";
const child = spawn(process.execPath, [cli, "dev", "--config", "src-tauri/tauri.dev.conf.json", ...process.argv.slice(2)], {
  cwd: site,
  env: {
    ...process.env,
    WORKBENCH_DEVELOPER_MODE: "1",
    WORKBENCH_DEV_LOG_DIR: root,
    WORKBENCH_DEV_SESSION_DIR: session,
    WORKBENCH_DEV_LAUNCHER_PID: String(process.pid),
    WORKBENCH_CDB_PATH: path.resolve(debuggerPath),
    RUST_BACKTRACE: process.env.RUST_BACKTRACE ?? "1",
    CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUNNER: runner,
    CARGO_TARGET_I686_PC_WINDOWS_MSVC_RUNNER: runner,
    CARGO_TARGET_AARCH64_PC_WINDOWS_MSVC_RUNNER: runner,
  },
  stdio: ["inherit", "pipe", "pipe"],
});

for (const [source, stream] of [["stdout", child.stdout], ["stderr", child.stderr]]) {
  createInterface({ input: stream }).on("line", (line) => record(source, line));
}
child.on("error", (error) => record("stderr", error.stack ?? error.message));
process.on("SIGINT", () => record("launcher", "Ctrl+C requested"));
child.on("close", (code, signal) => {
  record("launcher", `Tauri session ended: code=${code ?? "unknown"} signal=${signal ?? "none"}`);
  closeSync(file);
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
});
