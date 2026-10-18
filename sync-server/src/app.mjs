import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { ClientInputError } from "./database.mjs";
import { issueAccessToken, verifyAccessToken } from "./security.mjs";

const maxBodyBytes = 5 * 1024 * 1024;
const maxBlobBytes = 25 * 1024 * 1024;
const maxRateLimitEntries = 10_000;
const rateLimitWindowMs = 15 * 60 * 1000;

// 默认放行桌面端 Tauri webview 的来源（Windows/macOS/Linux 及开发模式），
// 避免开放 `*` 后任意网页都能直接调用登录等接口。
const defaultAllowedOrigins = [
  "http://tauri.localhost",
  "https://tauri.localhost",
  "tauri://localhost",
  "http://localhost",
  "http://localhost:1420",
];

export function createSyncServer({
  database,
  authSecret,
  logger = console,
  trustProxy = false,
  allowedOrigins = defaultAllowedOrigins,
}) {
  const attempts = new Map();
  const cors = createCorsPolicy(allowedOrigins);

  const server = http.createServer(async (request, response) => {
    applyCorsHeaders(request, response, cors);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url || "/", "http://localhost");
    try {
      if (request.method === "GET" && ["/v1/health", "/v3/health"].includes(url.pathname)) {
        sendJson(response, 200, {
          status: "ok",
          service: "mind-garden-sync",
          protocolVersions: [2, 3],
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/auth/login") {
        const client = rateLimitKey(
          attempts,
          clientAddress(request, trustProxy),
        );
        if (isRateLimited(attempts, client)) {
          sendJson(response, 429, { error: "尝试次数过多，请稍后再试。" });
          return;
        }
        const body = validateLoginBody(await readJson(request));
        const user = await database.authenticate(body.username, body.password);
        if (!user) {
          recordFailure(attempts, client);
          sendJson(response, 401, { error: "账户或密码不正确。" });
          return;
        }
        attempts.delete(client);
        const access = issueAccessToken(user, authSecret);
        const refresh = database.createRefreshSession(user, body.deviceId);
        sendJson(response, 200, {
          accessToken: access.token,
          expiresAt: access.expiresAt,
          username: user.username,
          ...refresh,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v3/auth/refresh") {
        const body = await readJson(request);
        const rotated = database.rotateRefreshSession(body.refreshToken);
        if (!rotated) {
          sendJson(response, 401, { error: "登录已过期，请重新登录。" });
          return;
        }
        const access = issueAccessToken(rotated.user, authSecret);
        sendJson(response, 200, {
          accessToken: access.token,
          expiresAt: access.expiresAt,
          username: rotated.user.username,
          refreshToken: rotated.refreshToken,
          refreshExpiresAt: rotated.refreshExpiresAt,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v3/auth/logout") {
        const body = await readJson(request);
        database.revokeRefreshSession(body.refreshToken);
        sendJson(response, 200, { loggedOut: true });
        return;
      }

      const user = authenticate(request, authSecret, database);
      if (!user) {
        sendJson(response, 401, { error: "请先登录。" });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/sync") {
        const body = await readJson(request);
        const result = database.sync(Number(user.sub), body);
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v3/sync") {
        const body = await readJson(request);
        const result = database.syncV3(Number(user.sub), body);
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v4/private/sync") {
        sendJson(response, 200, database.syncPrivate(Number(user.sub), await readJson(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/v4/private/pair") {
        sendJson(response, 200, database.pairPrivate(Number(user.sub), await readJson(request)));
        return;
      }

      const blobMatch = /^\/v3\/blobs\/([a-f\d]{64})$/i.exec(url.pathname);
      if (blobMatch && request.method === "HEAD") {
        const blob = database.getBlob(Number(user.sub), blobMatch[1]);
        if (!blob) {
          response.writeHead(404);
          response.end();
          return;
        }
        response.writeHead(200, {
          "Content-Type": blob.mimeType,
          "Content-Length": String(blob.bytes),
          ETag: `"sha256-${blobMatch[1].toLowerCase()}"`,
        });
        response.end();
        return;
      }

      if (blobMatch && request.method === "GET") {
        const blob = database.getBlob(Number(user.sub), blobMatch[1]);
        if (!blob) {
          sendJson(response, 404, { error: "附件不存在。" });
          return;
        }
        response.writeHead(200, {
          "Content-Type": blob.mimeType,
          "Content-Length": String(blob.bytes),
          ETag: `"sha256-${blobMatch[1].toLowerCase()}"`,
        });
        fs.createReadStream(blob.path).on("error", (error) => response.destroy(error)).pipe(response);
        return;
      }

      if (blobMatch && request.method === "PUT") {
        const stored = await receiveBlob(
          request,
          database,
          Number(user.sub),
          blobMatch[1],
        );
        sendJson(response, stored.created ? 201 : 200, {
          sha256: blobMatch[1].toLowerCase(),
          bytes: stored.bytes,
        });
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/auth/change-password"
      ) {
        const body = validatePasswordChange(await readJson(request));
        const changed = await database.changePassword(
          Number(user.sub),
          body.currentPassword,
          body.newPassword,
        );
        if (!changed) {
          sendJson(response, 400, { error: "当前密码不正确。" });
          return;
        }
        sendJson(response, 200, { changed: true });
        return;
      }

      sendJson(response, 404, { error: "接口不存在。" });
    } catch (error) {
      if (url.pathname.startsWith("/v4/private/")) {
        const status = error instanceof RequestTooLargeError ? 413 : error instanceof ClientInputError || error instanceof SyntaxError ? 400 : 500;
        if (status === 500) logger.error("private_request_failed");
        sendJson(response, status, { error: "私人同步请求未完成，请检查恢复码、网络和客户端版本。" });
        return;
      }
      if (error instanceof ClientInputError || error instanceof SyntaxError) {
        sendJson(response, 400, { error: error.message || "请求格式不正确。" });
        return;
      }
      if (error instanceof RequestTooLargeError) {
        sendJson(response, 413, { error: "请求内容过大。" });
        return;
      }
      logger.error("request_failed", error);
      sendJson(response, 500, { error: "服务器暂时无法处理这次同步。" });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return server;
}

function authenticate(request, secret, database) {
  const authorization = request.headers.authorization || "";
  if (!authorization.startsWith("Bearer ")) return null;
  const user = verifyAccessToken(authorization.slice(7), secret);
  if (!user) return null;
  const userId = Number(user.sub);
  if (!Number.isSafeInteger(userId)) return null;
  return database.isTokenCurrent(userId, user.ver) ? user : null;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new RequestTooLargeError();
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

// 构造 CORS 策略：支持 `*` 显式恢复全放开，其余值按精确来源匹配。
function createCorsPolicy(allowedOrigins) {
  const origins = new Set(
    allowedOrigins
      .map((value) => String(value).trim())
      .filter(Boolean),
  );
  if (!origins.size) {
    throw new Error("allowedOrigins 至少需要包含一个来源。");
  }
  return { origins, allowAll: origins.has("*") };
}

// 按请求的 Origin 头应用 CORS 与通用安全响应头：
// 无 Origin（非浏览器客户端）或来源不在白名单时，不输出 CORS 头，
// 由浏览器端拦截；安全头始终输出。
function applyCorsHeaders(request, response, cors) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !origin) return;
  if (!cors.allowAll && !cors.origins.has(origin)) return;
  response.setHeader("Access-Control-Allow-Origin", cors.allowAll ? "*" : origin);
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type",
  );
  response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, PUT, POST, OPTIONS");
  if (!cors.allowAll) response.setHeader("Vary", "Origin");
}

function clientAddress(request, trustProxy) {
  const forwarded = request.headers["x-forwarded-for"];
  if (trustProxy && typeof forwarded === "string") {
    const addresses = forwarded
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (addresses.length) return addresses.at(-1);
  }
  return request.socket.remoteAddress || "unknown";
}

function isRateLimited(attempts, client) {
  const entry = attempts.get(client);
  if (!entry) return false;
  if (Date.now() - entry.startedAt > rateLimitWindowMs) {
    attempts.delete(client);
    return false;
  }
  return entry.count >= 10;
}

function recordFailure(attempts, client) {
  const current = attempts.get(client);
  if (!current || Date.now() - current.startedAt > rateLimitWindowMs) {
    attempts.set(client, { count: 1, startedAt: Date.now() });
    return;
  }
  current.count += 1;
}

function rateLimitKey(attempts, address) {
  if (attempts.has(address)) return address;
  if (attempts.size >= maxRateLimitEntries) {
    const now = Date.now();
    for (const [key, entry] of attempts) {
      if (now - entry.startedAt > rateLimitWindowMs) attempts.delete(key);
    }
  }
  return attempts.size >= maxRateLimitEntries ? "rate-limit-overflow" : address;
}

function validateLoginBody(body) {
  if (!isRecord(body)) throw new ClientInputError("登录请求格式不正确。");
  const username = validateText(body.username, "账户", 1, 100).trim();
  const password = validateText(body.password, "密码", 1, 512, true);
  if (!username) throw new ClientInputError("账户不能为空。");
  const deviceId = body.deviceId === undefined
    ? ""
    : validateText(body.deviceId, "设备 ID", 0, 200).trim();
  return { username, password, deviceId };
}

function validatePasswordChange(body) {
  if (!isRecord(body)) throw new ClientInputError("改密请求格式不正确。");
  const currentPassword = validateText(
    body.currentPassword,
    "当前密码",
    1,
    512,
    true,
  );
  const newPassword = validateText(body.newPassword, "新密码", 12, 512, true);
  return { currentPassword, newPassword };
}

function validateText(value, label, minimum, maximumBytes, preserveWhitespace) {
  if (typeof value !== "string") {
    throw new ClientInputError(`${label}格式不正确。`);
  }
  const comparable = preserveWhitespace ? value : value.trim();
  if (comparable.length < minimum) {
    throw new ClientInputError(`${label}至少需要 ${minimum} 个字符。`);
  }
  if (Buffer.byteLength(comparable, "utf8") > maximumBytes) {
    throw new ClientInputError(`${label}过长。`);
  }
  return value;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function receiveBlob(request, database, userId, requestedHash) {
  const hash = requestedHash.toLowerCase();
  const mimeType = String(request.headers["content-type"] || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (!/^image\/(?:png|jpeg|gif|webp|bmp)$/.test(mimeType)) {
    throw new ClientInputError("Blob Content-Type 不受支持");
  }
  const declaredLength = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBlobBytes) {
    throw new RequestTooLargeError();
  }
  const target = database.blobPath(hash);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${hash}.${randomUUID()}.tmp`);
  const output = fs.createWriteStream(temporary, { flags: "wx" });
  const hasher = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > maxBlobBytes) throw new RequestTooLargeError();
      hasher.update(chunk);
      if (!output.write(chunk)) await once(output, "drain");
    }
    if (!bytes) throw new ClientInputError("Blob 内容为空");
    output.end();
    await once(output, "finish");
  } catch (error) {
    output.destroy();
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  const actualHash = hasher.digest("hex");
  if (actualHash !== hash) {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
    throw new ClientInputError("Blob 内容与 URL 哈希不一致");
  }
  const created = !fs.existsSync(target);
  if (created) await fs.promises.rename(temporary, target);
  else await fs.promises.rm(temporary, { force: true });
  database.registerBlob(userId, hash, bytes, mimeType);
  return { created, bytes };
}

class RequestTooLargeError extends Error {}
