import { invoke } from "@tauri-apps/api/core";
import { hex } from "./private-crypto";
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
export const systemSecrets: SecretStore = {
  get: key => invoke("plugin:companion-secrets|get", { key }),
  set: (key, value) => invoke("plugin:companion-secrets|set", { key, value }),
  remove: key => invoke("plugin:companion-secrets|remove", { key }),
};
export function normalizePrivateServer(server: string) {
  const url = new URL(server.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("私人同步需要 HTTPS 服务器地址。");
  return url.toString().replace(/\/+$/, "");
}
export async function accountBinding(server: string, username: string) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([normalizePrivateServer(server), username]))));
}
