export type AccessRole = "normal" | "admin";

export interface AuthConfig {
  SQL_NORMAL_PASSWORD?: unknown;
  SQL_ADMIN_PASSWORD?: unknown;
  AUTH_SECRET?: unknown;
}

interface ValidAuthConfig {
  SQL_NORMAL_PASSWORD: string;
  SQL_ADMIN_PASSWORD: string;
  AUTH_SECRET: string;
}

export interface SessionPayload {
  sub: "cf-sql-console";
  role: AccessRole;
  iat: number;
  exp: number;
}

export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** 校验双密码和签名密钥，避免服务在缺少凭据时静默降级。 */
export function assertAuthConfig(config: AuthConfig): asserts config is ValidAuthConfig {
  if (typeof config.SQL_NORMAL_PASSWORD !== "string" || config.SQL_NORMAL_PASSWORD.length === 0) {
    throw new ConfigurationError("SQL_NORMAL_PASSWORD 未配置");
  }
  if (typeof config.SQL_ADMIN_PASSWORD !== "string" || config.SQL_ADMIN_PASSWORD.length === 0) {
    throw new ConfigurationError("SQL_ADMIN_PASSWORD 未配置");
  }
  if (config.SQL_NORMAL_PASSWORD === config.SQL_ADMIN_PASSWORD) {
    throw new ConfigurationError("SQL_NORMAL_PASSWORD 和 SQL_ADMIN_PASSWORD 必须不同");
  }
  if (typeof config.AUTH_SECRET !== "string" || config.AUTH_SECRET.length < 32) {
    throw new ConfigurationError("AUTH_SECRET 必须至少包含 32 个字符");
  }
}

function toBase64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("非法 Base64URL");
  }
  const padded = `${value.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

async function hmac(value: string, secret: string): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return new Uint8Array(signature);
}

/** 用哈希后的定长字节比较密码，降低凭据比较的时序信息泄露。 */
export async function authenticatePassword(
  password: unknown,
  config: AuthConfig,
): Promise<AccessRole | null> {
  assertAuthConfig(config);
  if (typeof password !== "string" || password.length === 0) {
    return null;
  }

  const [candidate, normalPassword, adminPassword] = await Promise.all([
    sha256(password),
    sha256(config.SQL_NORMAL_PASSWORD),
    sha256(config.SQL_ADMIN_PASSWORD),
  ]);
  const isAdminPassword = constantTimeEqual(candidate, adminPassword);
  const isNormalPassword = constantTimeEqual(candidate, normalPassword);

  // admin 密码优先，且配置校验已禁止两套密码相同。
  if (isAdminPassword) {
    return "admin";
  }
  if (isNormalPassword) {
    return "normal";
  }
  return null;
}

/** 创建带过期时间的 HMAC 会话令牌；令牌本身不包含任何密码。 */
export async function createSessionToken(
  role: AccessRole,
  secret: string,
  now = Date.now(),
  ttlSeconds = SESSION_TTL_SECONDS,
): Promise<{ token: string; expiresAt: number }> {
  if (role !== "normal" && role !== "admin") {
    throw new Error("无效的访问角色");
  }
  if (typeof secret !== "string" || secret.length < 32) {
    throw new ConfigurationError("AUTH_SECRET 必须至少包含 32 个字符");
  }
  if (!Number.isFinite(now) || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("无效的会话时间");
  }

  const issuedAt = Math.floor(now / 1000);
  const payload: SessionPayload = {
    sub: "cf-sql-console",
    role,
    iat: issuedAt,
    exp: issuedAt + Math.floor(ttlSeconds),
  };
  const encodedHeader = toBase64Url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const encodedPayload = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const signature = toBase64Url(await hmac(unsignedToken, secret));

  return {
    token: `${unsignedToken}.${signature}`,
    expiresAt: payload.exp * 1000,
  };
}

/** 校验会话签名、主体、角色和过期时间；失败统一返回 null。 */
export async function verifySessionToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<SessionPayload | null> {
  if (typeof token !== "string" || typeof secret !== "string" || secret.length < 32) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return null;
  }

  try {
    const header = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0]))) as { alg?: string; typ?: string };
    if (header.alg !== "HS256" || header.typ !== "JWT") {
      return null;
    }

    const expectedSignature = await hmac(`${parts[0]}.${parts[1]}`, secret);
    const providedSignature = fromBase64Url(parts[2]);
    if (!constantTimeEqual(expectedSignature, providedSignature)) {
      return null;
    }

    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1]))) as Partial<SessionPayload>;
    const issuedAt = payload.iat;
    const expiresAt = payload.exp;
    if (
      payload.sub !== "cf-sql-console" ||
      (payload.role !== "normal" && payload.role !== "admin") ||
      typeof issuedAt !== "number" ||
      typeof expiresAt !== "number" ||
      !Number.isInteger(issuedAt) ||
      !Number.isInteger(expiresAt) ||
      expiresAt <= Math.floor(now / 1000) ||
      expiresAt <= issuedAt
    ) {
      return null;
    }
    return payload as SessionPayload;
  } catch {
    return null;
  }
}
