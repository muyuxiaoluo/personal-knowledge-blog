import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const scryptParameters = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
};

export function hashPassword(password) {
  assertPassword(password);
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, scryptParameters);
  return [
    "scrypt",
    scryptParameters.N,
    scryptParameters.r,
    scryptParameters.p,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export function verifyPassword(password, stored) {
  try {
    const [algorithm, n, r, p, saltValue, hashValue] = stored.split("$");
    if (algorithm !== "scrypt") return false;
    const expected = Buffer.from(hashValue, "base64url");
    const actual = scryptSync(
      password,
      Buffer.from(saltValue, "base64url"),
      expected.length,
      {
        N: Number(n),
        r: Number(r),
        p: Number(p),
        maxmem: scryptParameters.maxmem,
      },
    );
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function issueAccessToken(user, secret, ttlSeconds = 12 * 60 * 60) {
  if (!secret || secret.length < 32) {
    throw new Error("AUTH_SECRET must contain at least 32 characters");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const payload = encodeJson({
    sub: String(user.id),
    username: user.username,
    iat: now,
    exp: now + ttlSeconds,
  });
  const signature = sign(`${header}.${payload}`, secret);
  return {
    token: `${header}.${payload}.${signature}`,
    expiresAt: new Date((now + ttlSeconds) * 1000).toISOString(),
  };
}

export function verifyAccessToken(token, secret) {
  if (!token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = sign(`${header}.${payload}`, secret);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (
      typeof claims.sub !== "string" ||
      typeof claims.username !== "string" ||
      typeof claims.exp !== "number" ||
      claims.exp <= Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

function sign(value, secret) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function assertPassword(password) {
  if (typeof password !== "string" || password.length < 12) {
    throw new Error("密码至少需要 12 个字符");
  }
  if (Buffer.byteLength(password, "utf8") > 512) {
    throw new Error("密码过长");
  }
}
