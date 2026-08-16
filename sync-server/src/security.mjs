import {
  createHmac,
  randomBytes,
  scrypt,
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

export async function verifyPasswordAsync(password, stored) {
  try {
    const parameters = parsePasswordHash(stored);
    const actual = await derivePasswordAsync(
      password,
      parameters.salt,
      parameters.expected.length,
      parameters.options,
    );
    return (
      parameters.expected.length === actual.length &&
      timingSafeEqual(parameters.expected, actual)
    );
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
    ver: user.authVersion,
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
    const tokenHeader = JSON.parse(
      Buffer.from(header, "base64url").toString("utf8"),
    );
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (
      tokenHeader.alg !== "HS256" ||
      tokenHeader.typ !== "JWT" ||
      typeof claims.sub !== "string" ||
      typeof claims.username !== "string" ||
      !Number.isSafeInteger(claims.ver) ||
      claims.ver < 1 ||
      typeof claims.iat !== "number" ||
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

function parsePasswordHash(stored) {
  if (typeof stored !== "string") throw new Error("密码哈希格式不正确");
  const [algorithm, n, r, p, saltValue, hashValue] = stored.split("$");
  if (algorithm !== "scrypt") throw new Error("密码哈希算法不正确");
  const N = Number(n);
  const blockSize = Number(r);
  const parallelization = Number(p);
  if (
    !Number.isSafeInteger(N) ||
    !Number.isSafeInteger(blockSize) ||
    !Number.isSafeInteger(parallelization) ||
    N < 2 ||
    blockSize < 1 ||
    parallelization < 1
  ) {
    throw new Error("密码哈希参数不正确");
  }
  return {
    salt: Buffer.from(saltValue, "base64url"),
    expected: Buffer.from(hashValue, "base64url"),
    options: {
      N,
      r: blockSize,
      p: parallelization,
      maxmem: scryptParameters.maxmem,
    },
  };
}

function derivePasswordAsync(password, salt, length, options) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

function assertPassword(password) {
  if (typeof password !== "string" || password.length < 12) {
    throw new Error("密码至少需要 12 个字符");
  }
  if (Buffer.byteLength(password, "utf8") > 512) {
    throw new Error("密码过长");
  }
}
