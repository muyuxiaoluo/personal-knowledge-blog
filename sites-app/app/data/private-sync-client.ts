import { PrivateCrypto } from "./private-crypto";
import { PrivateRepository, type PrivateResponse } from "./private-repository";
import { accountBinding, normalizePrivateServer, type SecretStore } from "./secret-store";
export type PrivateSession = { accessToken: string; expiresAt: string; username: string; refreshToken: string; refreshExpiresAt: string };
export class PrivateRequestError extends Error {}
export async function privateRequest(server: string, endpoint: string, body: unknown, token?: string): Promise<unknown> {
  try {
    const response = await fetch(`${normalizePrivateServer(server)}${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: "error" });
    if (!response.ok) {
      const login = endpoint === "/v1/auth/login";
      throw new PrivateRequestError(response.status === 401
        ? login ? "账户或密码不正确，请检查服务器地址与同步账户。" : "登录已过期，请重新登录。"
        : response.status === 429 ? "尝试次数过多，请稍后再试。"
        : response.status === 404 && endpoint === "/v4/private/photos/sync" ? "服务器尚未支持餐食照片同步，请先升级同步服务；照片仍保存在本机。"
        : response.status === 404 && endpoint.startsWith("/v4/") ? "服务器尚未支持私人同步，请先升级同步服务。"
        : response.status === 400 ? login ? "请检查用户名和密码是否填写完整。" : "私人同步校验失败，请确认恢复码与服务器版本。"
        : "同步服务暂不可用，请稍后重试。");
    }
    const text = await response.text();
    if (text.length > 30_000_000) throw new PrivateRequestError("同步响应过大。");
    return JSON.parse(text);
  } catch (e) {
    if (e instanceof PrivateRequestError) throw e;
    throw new PrivateRequestError("无法连接同步服务器，请检查网络和 HTTPS 地址；本机记录不受影响。");
  }
}
export class CompanionAccount {
  session: PrivateSession | null = null;
  private refreshInFlight: Promise<string> | null = null;
  private restoreInFlight: Promise<void> | null = null;
  constructor(readonly server: string, readonly repository: PrivateRepository, private secrets: SecretStore) {}
  private async save(value: unknown) {
    const session = value as PrivateSession;
    if (!session || typeof session.accessToken !== "string" || !session.accessToken || typeof session.refreshToken !== "string" || session.refreshToken.length < 32 || typeof session.username !== "string" || !Number.isFinite(Date.parse(session.expiresAt)) || !Number.isFinite(Date.parse(session.refreshExpiresAt))) throw new Error("登录响应无效。");
    await this.secrets.set("companion_session", JSON.stringify({ serverUrl: normalizePrivateServer(this.server), ...session, accessToken: undefined, expiresAt: undefined }));
    this.session = session;
    return session;
  }
  async login(username: string, password: string) { return this.save(await privateRequest(this.server, "/v1/auth/login", { username, password, deviceId: await this.repository.deviceId() })); }
  async restore() {
    this.restoreInFlight ??= this.restoreStored().finally(() => { this.restoreInFlight = null; });
    return this.restoreInFlight;
  }
  private async restoreStored() {
    const encoded = await this.secrets.get("companion_session");
    if (!encoded) return;
    const stored = JSON.parse(encoded);
    if (stored.serverUrl !== normalizePrivateServer(this.server)) return;
    await this.save(await privateRequest(this.server, "/v3/auth/refresh", { refreshToken: stored.refreshToken }));
  }
  async token() {
    if (!this.session) throw new Error("请先登录同步账户。");
    if (Date.parse(this.session.expiresAt) > Date.now() + 60000) return this.session.accessToken;
    this.refreshInFlight ??= privateRequest(this.server, "/v3/auth/refresh", { refreshToken: this.session.refreshToken }).then(s => this.save(s)).then(s => s.accessToken).finally(() => { this.refreshInFlight = null; });
    return this.refreshInFlight;
  }
  async logout() {
    const encoded = await this.secrets.get("companion_session");
    const refreshToken = this.session?.refreshToken ?? (encoded ? JSON.parse(encoded).refreshToken : null);
    // Retain credentials on a failed revocation so the user can retry explicitly.
    if (refreshToken) await privateRequest(this.server, "/v3/auth/logout", { refreshToken });
    await this.secrets.remove("companion_session");
    this.session = null;
  }
}
const repositoryRuns = new WeakMap<PrivateRepository, Promise<void>>();
export class PrivateSyncClient {
  constructor(private repository: PrivateRepository, private server: string, private username: string, private token: () => Promise<string>, private secrets: SecretStore, private transport = privateRequest) {}
  sync() {
    const existing = repositoryRuns.get(this.repository);
    if (existing) return existing;
    const running = this.run().finally(() => { repositoryRuns.delete(this.repository); });
    repositoryRuns.set(this.repository, running);
    return running;
  }
  private async run() {
    await this.runStream(this.repository, "/v4/private/sync");
    if (await this.repository.meta("photo_enabled") === "1") {
      await this.runStream(this.repository.photoRepository(), "/v4/private/photos/sync");
    }
  }
  private async runStream(repository: PrivateRepository, endpoint: string) {
    const binding = await accountBinding(this.server, this.username);
    const enabled = async () => await repository.meta("enabled") === "1" && (!repository.photoStream || await repository.meta("photo_enabled") === "1");
    if (!await enabled() || await repository.meta("binding") !== binding) return;
    const code = await this.secrets.get(`private_${binding}`);
    if (!code) throw new Error("请用恢复码配对私人同步。");
    const cipher = await PrivateCrypto.fromRecoveryCode(code);
    if (cipher.keyId !== await repository.meta("key_id")) throw new Error("私人同步密钥不匹配。");
    for (let page = 0; page < 100; page++) {
      if (!await enabled()) return;
      const changes = await repository.prepare(cipher);
      const cursor = Number(await repository.meta("cursor") || 0);
      const token = await this.token();
      if (!await enabled()) return;
      const response = await this.transport(this.server, endpoint, { version: 4, keyId: cipher.keyId, deviceId: await repository.deviceId(), cursor, changes }, token) as PrivateResponse;
      if (!await enabled()) return;
      await repository.receive(response, cipher, changes, cursor);
      if (!response.hasMore && changes.length === 0) return;
    }
    throw new Error("本轮同步已达分页上限，请继续同步。");
  }
}
