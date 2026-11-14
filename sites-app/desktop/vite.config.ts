import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const host = process.env.TAURI_DEV_HOST;
const kib = 1024;

function buildBudget(): Plugin {
  return {
    name: "desktop-build-budget",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        const bytes = Buffer.byteLength(output.code);
        if (bytes > 500 * kib) {
          this.error(`懒加载代码块 ${output.fileName} 为 ${(bytes / kib).toFixed(1)} KiB，超过 500 KiB 预算。`);
        }
      }

      const entry = Object.values(bundle).find((output) => output.type === "chunk" && output.isEntry);
      if (!entry || entry.type !== "chunk") return;
      const branches = entry.dynamicImports.length > 0 ? entry.dynamicImports : [entry.fileName];
      for (const branch of branches) {
        const pending = [entry.fileName, branch];
        const visited = new Set<string>();
        const css = new Set<string>();
        let initialJsBytes = 0;
        while (pending.length > 0) {
          const fileName = pending.pop();
          if (!fileName || visited.has(fileName)) continue;
          visited.add(fileName);
          const output = bundle[fileName];
          if (!output || output.type !== "chunk") continue;
          initialJsBytes += Buffer.byteLength(output.code);
          output.imports.forEach((dependency) => pending.push(dependency));
          output.viteMetadata?.importedCss.forEach((file) => css.add(file));
        }
        const initialCssBytes = [...css].reduce((sum, fileName) => {
          const output = bundle[fileName];
          return sum + (output?.type === "asset"
            ? Buffer.byteLength(typeof output.source === "string" ? output.source : output.source)
            : 0);
        }, 0);
        if (initialJsBytes > 500 * kib) {
          this.error(`初始分支 ${branch} 的 JavaScript 为 ${(initialJsBytes / kib).toFixed(1)} KiB，超过 500 KiB 预算。`);
        }
        if (initialCssBytes > 200 * kib) {
          this.error(`初始分支 ${branch} 的 CSS 为 ${(initialCssBytes / kib).toFixed(1)} KiB，超过 200 KiB 预算。`);
        }
      }
    },
  };
}

function reloadPersistentRuntime(): Plugin {
  return {
    name: "reload-persistent-desktop-runtime",
    apply: "serve",
    handleHotUpdate({ file, server }) {
      // Repository instances outlive React refresh and must be recreated with their migrations.
      if (file.replaceAll("\\", "/").includes("/app/data/")) {
        server.ws.send({ type: "full-reload" });
        return [];
      }
    },
  };
}

export default defineConfig({
  root: "desktop",
  plugins: [react(), reloadPersistentRuntime(), buildBudget()],
  clearScreen: false,
  server: {
    forwardConsole: process.env.WORKBENCH_DEVELOPER_MODE === "1"
      ? { logLevels: ["debug", "log", "info", "warn", "error"], unhandledErrors: true }
      : undefined,
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    outDir: "../desktop-dist",
    emptyOutDir: true,
    target: ["es2021", "chrome105", "safari13"],
  },
});
