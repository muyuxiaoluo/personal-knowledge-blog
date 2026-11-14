import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const [executable, ...args] = process.argv.slice(2);
if (!executable) throw new Error("Cargo did not provide an executable.");

async function archiveBuild(root) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(executable)) hash.update(chunk);
  const id = hash.digest("hex");
  const builds = path.join(root, "builds");
  await mkdir(builds, { recursive: true });
  const archive = path.join(builds, id);
  const existing = await readdir(builds, { withFileTypes: true });
  if (!existing.some((entry) => entry.isDirectory() && entry.name === id)) {
    const temporary = await mkdtemp(path.join(builds, ".building-"));
    try {
      await copyFile(executable, path.join(temporary, path.basename(executable)));
      await copyFile(path.join(path.dirname(executable), "life_strategy_library.pdb"), path.join(temporary, "life_strategy_library.pdb"));
      try { await rename(temporary, archive); }
      catch (error) {
        if (!(await readdir(builds)).includes(id)) throw error;
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  console.error(`[app-runner] Debug build: ${archive}`);
  return id;
}

let buildId;
if (process.env.WORKBENCH_DEV_LOG_DIR) {
  try { buildId = await archiveBuild(process.env.WORKBENCH_DEV_LOG_DIR); }
  catch (error) { console.error(`[app-runner] Could not archive executable and symbols: ${error.message}`); }
}

function observe(pid, session) {
  const script = fileURLToPath(new URL("./observe-development-exit.ps1", import.meta.url));
  const log = path.join(session, `process-${pid}.jsonl`);
  let errors;
  try {
    errors = openSync(path.join(session, `observer-${pid}.launch.log`), "a");
    // Start-Process creates a separate Windows console with a hidden window.
    // PowerShell does not reliably start directly with libuv's detached flag.
    const errorLog = path.join(session, `observer-${pid}.stderr.log`);
    const observer = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script, "-Launch"], {
      windowsHide: true,
      stdio: ["ignore", "ignore", errors],
      env: {
        ...process.env,
        WORKBENCH_OBSERVER_ERRORS: errorLog,
        WORKBENCH_OBSERVED_PID: String(pid),
        WORKBENCH_OBSERVED_EXECUTABLE: path.resolve(executable),
        WORKBENCH_OBSERVED_BUILD: buildId ?? "",
        WORKBENCH_OBSERVER_LOG: log,
      },
    });
    observer.once("spawn", () => console.error(`[app-runner] Process observer log: ${log}`));
    observer.once("error", (error) => console.error(`[app-runner] Could not start process observer: ${error.message}`));
    observer.unref();
  } catch (error) {
    console.error(`[app-runner] Could not start process observer: ${error.message}`);
  } finally {
    if (errors !== undefined) closeSync(errors);
  }
}

const session = process.env.WORKBENCH_DEV_SESSION_DIR;
const debuggerPath = process.env.WORKBENCH_CDB_PATH;
const capture = process.platform === "win32" && session && debuggerPath;
let appPid;
let appExitCode;
let child;

if (capture) {
  const commandFile = path.join(session, `debugger-${process.pid}.txt`);
  const debuggerLog = path.join(session, `debugger-${process.pid}.log`);
  const dump = path.join(session, `crash-${process.pid}.dmp`);
  const dumpCommand = `.lastevent; .dump /ma \\"${dump.replaceAll("\\", "/")}\\"; gn`;
  await writeFile(commandFile, [
    ...["av", "0xc0000374", "0xc0000409", "0xc000001d", "0xc00000fd", "*"].map(
      (exception) => `sxd -c2 "${dumpCommand}" ${exception}`,
    ),
    'sxe -c ".lastevent; q" epr',
    '.printf "WORKBENCH_DEBUG_PID=%d\\n", @$tpid',
    "g",
    "",
  ].join("\r\n"));
  console.error(`[app-runner] Native debugger log: ${debuggerLog}`);
  child = spawn(debuggerPath, ["-hd", "-cf", commandFile, "-logo", debuggerLog, path.resolve(executable), ...args], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const started = /^WORKBENCH_DEBUG_PID=(\d+)$/.exec(line);
    if (started) {
      appPid = Number(started[1]);
      console.error(`[app-runner] Started workbench pid=${appPid} with native crash capture`);
      observe(appPid, session);
    }
    const exited = /^Last event: .*: Exit process [\da-f]+:[\da-f]+, code (?:0x)?([\da-f]+)\b/i.exec(line);
    if (exited) appExitCode = Number.parseInt(exited[1], 16);
    if (!line.startsWith("ModLoad:")) console.log(line);
  });
} else {
  child = spawn(path.resolve(executable), args, { stdio: "inherit" });
  child.once("spawn", () => {
    appPid = child.pid;
    console.error(`[app-runner] Started workbench pid=${appPid}`);
    if (process.platform === "win32" && session) observe(appPid, session);
  });
}

child.once("error", (error) => console.error(`[app-runner] ${error.stack ?? error.message}`));
child.once("close", (code, signal) => {
  const exitCode = capture ? appExitCode : code;
  if (capture && exitCode === undefined) {
    console.error(`[app-runner] Native debugger stopped without reporting the workbench exit (debugger code=${code ?? "unknown"})`);
  }
  const status = exitCode == null ? "unknown" : `0x${(exitCode >>> 0).toString(16).padStart(8, "0")}`;
  console.error(`[app-runner] Workbench exited: pid=${appPid ?? "unknown"} code=${exitCode ?? "unknown"} (${status}) signal=${signal ?? "none"}`);
  process.exitCode = exitCode ?? (signal === "SIGINT" ? 130 : 1);
});
process.on("SIGINT", () => {});
