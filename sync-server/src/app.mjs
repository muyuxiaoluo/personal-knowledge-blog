import http from "node:http";
import { ClientInputError } from "./database.mjs";
import { issueAccessToken, verifyAccessToken } from "./security.mjs";

const maxBodyBytes = 5 * 1024 * 1024;

export function createSyncServer({ database, authSecret, logger = console }) {
  const attempts = new Map();

  return http.createServer(async (request, response) => {
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
          version: "0.2.0",
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/auth/login") {
        const client = clientAddress(request);
        if (isRateLimited(attempts, client)) {
          sendJson(response, 429, { error: "尝试次数过多，请稍后再试。" });
          return;
        }
        const body = await readJson(request);
        const user = database.authenticate(body.username, body.password);
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

      const user = authenticate(request, authSecret);
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
        const body = await readJson(request);
        const changed = database.changePassword(
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
}

function authenticate(request, secret) {
  const authorization = request.headers.authorization || "";
  if (!authorization.startsWith("Bearer ")) return null;
  return verifyAccessToken(authorization.slice(7), secret);
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

function clientAddress(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return request.socket.remoteAddress || "unknown";
}

function isRateLimited(attempts, client) {
  const entry = attempts.get(client);
  if (!entry) return false;
  if (Date.now() - entry.startedAt > 15 * 60 * 1000) {
    attempts.delete(client);
    return false;
  }
  return entry.count >= 10;
}

function recordFailure(attempts, client) {
  const current = attempts.get(client);
  if (!current || Date.now() - current.startedAt > 15 * 60 * 1000) {
    attempts.set(client, { count: 1, startedAt: Date.now() });
    return;
  }
  current.count += 1;
}

class RequestTooLargeError extends Error {}
