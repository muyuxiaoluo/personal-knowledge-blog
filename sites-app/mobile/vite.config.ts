import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({ root: "mobile", plugins: [react()], clearScreen: false,
  server: { port: 1420, strictPort: true, host: process.env.TAURI_DEV_HOST || false },
  build: { outDir: "../mobile-dist", emptyOutDir: true, target: "chrome105" },
});
