import http from "node:http";
import { ClientInputError } from "./database.mjs";
import { issueAccessToken, verifyAccessToken } from "./security.mjs";

const maxBodyBytes = 5 * 1024 * 1024;
const maxRateLimitEntries = 10_000;
const rateLimitWindowMs = 15 * 60 * 1000;

export function createSyncServer({
  database,
  authSecret,
  logger = console,
  trustProxy = false,
}) {
  const attempts = new Map();

  const server = http.createServer(async (request, response) => {
    setCommonHeaders(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url || "/", "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/v1/health") {
        sendJson(response, 200, {
          status: "ok",
          service: "mind-garden-sync",
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
        sendJson(response, 200, {
          accessToken: access.token,
          expiresAt: access.expiresAt,
          username: user.username,
        });
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

function setCommonHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type",
  );
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
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
  return { username, password };
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

class RequestTooLargeError extends Error {}
