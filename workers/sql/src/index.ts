import {
  assertAuthConfig,
  authenticatePassword,
  ConfigurationError,
  createSessionToken,
  verifySessionToken,
  type AccessRole,
} from "./auth";
import {
  createRecord,
  createTable,
  deleteRecord,
  dropTable,
  exportRecords,
  executeSql,
  importRecords,
  listRecords,
  readSchema,
  SqlExecutionError,
  SqlValidationError,
  updateRecord,
} from "./sql";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SQL_NORMAL_PASSWORD: string;
  SQL_ADMIN_PASSWORD: string;
  AUTH_SECRET: string;
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(value));
  }
  return value;
}

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, jsonReplacer), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      ...headers,
    },
  });
}

/** 复制静态资源响应后再添加安全头，兼容 Workers 返回的 immutable Headers。 */
export function addAssetSecurityHeaders(response: Response, requestId?: string): Response {
  const headers = new Headers(response.headers);
  if (requestId) headers.set("x-request-id", requestId);
  headers.set("cache-control", "no-cache, must-revalidate");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  headers.set(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function objectBody(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "INVALID_JSON", "请求体必须是 JSON 对象");
  }
  return body as Record<string, unknown>;
}

async function readJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 1_200_000) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "请求体过大");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 1_200_000) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "请求体过大");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "请求体必须是合法 JSON");
  }
}

function requireJsonMethod(request: Request): void {
  if (request.method !== "POST") {
    throw new HttpError(405, "METHOD_NOT_ALLOWED", "该接口只接受 POST 请求");
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "请求必须使用 application/json");
  }
}

async function requireSession(request: Request, env: Env): Promise<{ role: AccessRole }> {
  assertAuthConfig(env);
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  if (!match) {
    throw new HttpError(401, "AUTH_REQUIRED", "请先使用密码登录");
  }
  const payload = await verifySessionToken(match[1], env.AUTH_SECRET);
  if (!payload) {
    throw new HttpError(401, "AUTH_INVALID", "登录已失效，请重新登录");
  }
  return { role: payload.role };
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  requireJsonMethod(request);
  assertAuthConfig(env);
  const body = objectBody(await readJson(request));
  const role = await authenticatePassword(body.password, env);
  if (!role) {
    throw new HttpError(401, "INVALID_CREDENTIALS", "密码错误");
  }
  const session = await createSessionToken(role, env.AUTH_SECRET);
  return jsonResponse({ ok: true, role, expiresAt: session.expiresAt, token: session.token });
}

async function handleSql(request: Request, env: Env, role: AccessRole): Promise<Response> {
  requireJsonMethod(request);
  const body = objectBody(await readJson(request));
  const result = await executeSql(env.DB, { sql: body.sql, params: body.params }, role);
  return jsonResponse({ ok: true, ...result });
}

async function handleSchema(request: Request, env: Env): Promise<Response> {
  requireJsonMethod(request);
  const body = objectBody(await readJson(request));
  const result = await readSchema(env.DB, body.table as string | undefined);
  return jsonResponse({ ok: true, ...result });
}

async function handleRecordList(request: Request, env: Env): Promise<Response> {
  requireJsonMethod(request);
  const body = objectBody(await readJson(request));
  const result = await listRecords(env.DB, body.table, body.limit, body.offset);
  return jsonResponse({ ok: true, ...result });
}

async function handleRecordExport(request: Request, env: Env): Promise<Response> {
  requireJsonMethod(request);
  const body = objectBody(await readJson(request));
  const result = await exportRecords(env.DB, body.table);
  return jsonResponse({ ok: true, ...result });
}

async function handleRecordImport(request: Request, env: Env, role: AccessRole): Promise<Response> {
  requireJsonMethod(request);
  const body = objectBody(await readJson(request));
  const result = await importRecords(env.DB, body.table, body.records, role);
  return jsonResponse({ ok: true, ...result });
}

async function handleRecordCreate(request: Request, env: Env, role: AccessRole): Promise<Response> {
  requireJsonMethod(request);
  const body = objectBody(await readJson(request));
  const result = await createRecord(env.DB, body.table, body.values, role);
  return jsonResponse({ ok: true, ...result });
}

async function handleRecordUpdate(request: Request, env: Env, role: AccessRole): Promise<Response> {
  requireJsonMethod(request);
  const body = objectBody(await readJson(request));
  const result = await updateRecord(env.DB, body.table, body.primaryKey, body.primaryKeyValue, body.values, role);
  return jsonResponse({ ok: true, ...result });
}

async function handleRecordDelete(request: Request, env: Env, role: AccessRole): Promise<Response> {
  requireJsonMethod(request);
  const body = objectBody(await readJson(request));
  const result = await deleteRecord(env.DB, body.table, body.primaryKey, body.primaryKeyValue, role);
  return jsonResponse({ ok: true, ...result });
}

async function handleTableCreate(request: Request, env: Env, role: AccessRole): Promise<Response> {
  requireJsonMethod(request);
  const body = objectBody(await readJson(request));
  const result = await createTable(env.DB, { name: body.name, columns: body.columns }, role);
  return jsonResponse({ ok: true, ...result });
}

async function handleTableDrop(request: Request, env: Env, role: AccessRole): Promise<Response> {
  requireJsonMethod(request);
  const body = objectBody(await readJson(request));
  const result = await dropTable(env.DB, body.table, role);
  return jsonResponse({ ok: true, ...result });
}

async function routeApi(request: Request, env: Env): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/api/auth/login") {
    return handleLogin(request, env);
  }
  const protectedPaths = new Set([
    "/api/sql",
    "/api/schema",
    "/api/tables/list",
    "/api/tables/create",
    "/api/tables/drop",
    "/api/records/list",
    "/api/records/export",
    "/api/records/import",
    "/api/records/create",
    "/api/records/update",
    "/api/records/delete",
  ]);
  if (protectedPaths.has(pathname)) {
    const session = await requireSession(request, env);
    switch (pathname) {
      case "/api/sql":
        return handleSql(request, env, session.role);
      case "/api/schema":
      case "/api/tables/list":
        return handleSchema(request, env);
      case "/api/records/list":
        return handleRecordList(request, env);
      case "/api/records/export":
        return handleRecordExport(request, env);
      case "/api/records/import":
        return handleRecordImport(request, env, session.role);
      case "/api/records/create":
        return handleRecordCreate(request, env, session.role);
      case "/api/records/update":
        return handleRecordUpdate(request, env, session.role);
      case "/api/records/delete":
        return handleRecordDelete(request, env, session.role);
      case "/api/tables/create":
        return handleTableCreate(request, env, session.role);
      case "/api/tables/drop":
        return handleTableDrop(request, env, session.role);
    }
  }
  throw new HttpError(404, "NOT_FOUND", "接口不存在");
}

function handleError(error: unknown, requestId: string): Response {
  if (error instanceof HttpError) {
    return jsonResponse(
      { error: { code: error.code, message: error.message }, requestId },
      error.status,
      error.status === 401 ? { "www-authenticate": "Bearer" } : {},
    );
  }
  if (error instanceof SqlValidationError) {
    return jsonResponse({ error: { code: "SQL_VALIDATION_ERROR", message: error.message }, requestId }, 400);
  }
  if (error instanceof SqlExecutionError) {
    return jsonResponse(
      {
        error: { code: "SQL_EXECUTION_ERROR", message: "SQL 执行失败", details: error.message },
        requestId,
      },
      400,
    );
  }
  if (error instanceof ConfigurationError) {
    return jsonResponse(
      { error: { code: "CONFIGURATION_ERROR", message: "服务端鉴权配置不完整" }, requestId },
      500,
    );
  }
  return jsonResponse(
    { error: { code: "INTERNAL_ERROR", message: "服务器内部错误" }, requestId },
    500,
  );
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    const requestId = globalThis.crypto.randomUUID();
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        const response = await routeApi(request, env);
        response.headers.set("x-request-id", requestId);
        return response;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "页面只接受 GET 请求");
      }
      if (!env.ASSETS) {
        throw new ConfigurationError("ASSETS 未配置");
      }
      return addAssetSecurityHeaders(await env.ASSETS.fetch(request), requestId);
    } catch (error) {
      console.error("[cf-sql] request failed", { requestId, method: request.method, url: request.url, error });
      const response = handleError(error, requestId);
      response.headers.set("x-request-id", requestId);
      return response;
    }
  },
};

export default worker;
