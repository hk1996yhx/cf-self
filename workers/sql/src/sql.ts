import type { AccessRole } from "./auth";

export const MAX_SQL_LENGTH = 100_000;
export const MAX_PARAMETER_COUNT = 100;

export type SqlParameter = string | number | null;
export type SqlStatementType = "read" | "crud" | "create-table" | "drop-table" | "admin";

export interface SqlRequest {
  sql: unknown;
  params?: unknown;
}

export interface SqlExecutionResult {
  type: "rows" | "command";
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  meta: {
    durationMs: number;
    changes?: number | null;
    lastRowId?: number | null;
  };
}

export interface SchemaTable {
  name: string;
  type: string;
  sql: string | null;
}

export interface SchemaColumn {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

export class SqlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlValidationError";
  }
}

export class SqlExecutionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "SqlExecutionError";
  }
}

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_]/.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_$]/.test(character);
}

function skipQuotedText(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] === quote) {
      if (sql[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return sql.length;
}

interface SqlScan {
  topLevelTokens: string[];
  separators: number[];
}

function scanSql(sql: string): SqlScan {
  const topLevelTokens: string[] = [];
  const separators: number[] = [];
  let depth = 0;
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];

    if (character === "-" && next === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < sql.length && !(sql[index] === "*" && sql[index + 1] === "/")) {
        index += 1;
      }
      index = Math.min(index + 2, sql.length);
      continue;
    }
    if (character === "'" || character === '"' || character === "`" || character === "[") {
      const quote = character === "[" ? "]" : character;
      index = skipQuotedText(sql, index, quote);
      continue;
    }
    if (character === ";") {
      separators.push(index);
      index += 1;
      continue;
    }
    if (character === "(") {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === ")") {
      depth = Math.max(0, depth - 1);
      index += 1;
      continue;
    }
    if (isIdentifierStart(character)) {
      let end = index + 1;
      while (end < sql.length && isIdentifierPart(sql[end])) {
        end += 1;
      }
      if (depth === 0) {
        topLevelTokens.push(sql.slice(index, end).toLowerCase());
      }
      index = end;
      continue;
    }
    index += 1;
  }

  return { topLevelTokens, separators };
}

function hasMeaningfulSql(sql: string): boolean {
  let index = 0;
  while (index < sql.length) {
    if (/\s/.test(sql[index])) {
      index += 1;
      continue;
    }
    if (sql[index] === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (sql[index] === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    return true;
  }
  return false;
}

/** 校验 SQL 长度和单语句约束，避免一次请求隐式执行多条语句。 */
export function validateSql(sql: unknown): string {
  if (typeof sql !== "string") {
    throw new SqlValidationError("sql 必须是字符串");
  }
  const normalizedSql = sql.trim();
  if (normalizedSql.length === 0) {
    throw new SqlValidationError("sql 不能为空");
  }
  if (normalizedSql.length > MAX_SQL_LENGTH) {
    throw new SqlValidationError(`sql 长度不能超过 ${MAX_SQL_LENGTH} 个字符`);
  }

  const { separators } = scanSql(normalizedSql);
  if (separators.length > 0 && hasMeaningfulSql(normalizedSql.slice(separators[0] + 1))) {
    throw new SqlValidationError("每次请求只能执行一条 SQL 语句");
  }
  return normalizedSql;
}

function isSafePragma(sql: string): boolean {
  return /^pragma\s+(?:(?:main|temp)\.)?(?:table_info|table_xinfo|index_list|index_info|foreign_key_list|database_list)\s*(?:\(|;|$)/i.test(
    sql,
  );
}

function classifyValidatedSql(sql: string): SqlStatementType {
  const { topLevelTokens } = scanSql(sql);
  const firstKeyword = topLevelTokens[0];
  if (!firstKeyword) {
    throw new SqlValidationError("无法识别 SQL 语句");
  }

  if (firstKeyword === "select" || firstKeyword === "values" || firstKeyword === "explain") {
    return "read";
  }
  if (firstKeyword === "pragma") {
    return isSafePragma(sql) ? "read" : "admin";
  }
  if (["insert", "update", "delete", "replace"].includes(firstKeyword)) {
    return "crud";
  }
  if (firstKeyword === "create" && topLevelTokens[1] === "table") {
    return "create-table";
  }
  if (firstKeyword === "drop" && topLevelTokens[1] === "table") {
    return "drop-table";
  }
  if (firstKeyword === "with") {
    const mainKeyword = topLevelTokens.slice(1).find((keyword) =>
      ["select", "values", "insert", "update", "delete", "replace"].includes(keyword),
    );
    if (mainKeyword === "select" || mainKeyword === "values") {
      return "read";
    }
    if (["insert", "update", "delete", "replace"].includes(mainKeyword ?? "")) {
      return "crud";
    }
    return "admin";
  }
  return "admin";
}

/** 将 SQL 分类为查询、记录级 CRUD、建表、删表或不支持的结构操作。 */
export function classifySql(sql: unknown): SqlStatementType {
  return classifyValidatedSql(validateSql(sql));
}

/** 将 HTTP JSON 参数转换为 D1 支持的绑定值，禁止把对象直接拼进 SQL。 */
export function normalizeParameters(params: unknown): SqlParameter[] {
  if (params === undefined) {
    return [];
  }
  if (!Array.isArray(params)) {
    throw new SqlValidationError("params 必须是数组");
  }
  if (params.length > MAX_PARAMETER_COUNT) {
    throw new SqlValidationError(`params 不能超过 ${MAX_PARAMETER_COUNT} 个`);
  }

  return params.map((parameter, index) => {
    if (parameter === null || typeof parameter === "string") {
      return parameter;
    }
    if (typeof parameter === "number" && Number.isFinite(parameter)) {
      return parameter;
    }
    if (typeof parameter === "boolean") {
      return parameter ? 1 : 0;
    }
    throw new SqlValidationError(`params[${index}] 只能是字符串、数字、布尔值或 null`);
  });
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getColumns(rows: Array<Record<string, unknown>>): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (!seen.has(column)) {
        seen.add(column);
        columns.push(column);
      }
    }
  }
  return columns;
}

/** 执行单条 D1 语句，并将查询和写操作统一为控制台可消费的结果结构。 */
export async function executeSql(
  database: D1Database,
  request: SqlRequest,
  role: AccessRole,
): Promise<SqlExecutionResult> {
  const sql = validateSql(request.sql);
  const statementType = classifyValidatedSql(sql);
 if (statementType === "drop-table" && role !== "admin") {
   throw new SqlValidationError("只有 admin 密码可以删除数据表");
 }
  if (statementType === "admin" && role !== "admin") {
    throw new SqlValidationError("普通密码只支持查询、记录增删改查和建表，其他操作需要 admin 权限");
 }
 const params = normalizeParameters(request.params);
  const startedAt = Date.now();

  try {
    const prepared = database.prepare(sql);
    const statement = params.length > 0 ? prepared.bind(...params) : prepared;

    if (statementType === "read") {
      const result = await statement.all<Record<string, unknown>>();
      const rows = (result.results ?? []) as Array<Record<string, unknown>>;
      return {
        type: "rows",
        columns: getColumns(rows),
        rows,
        rowCount: rows.length,
        meta: { durationMs: Date.now() - startedAt },
      };
    }

    const result = await statement.run();
    const changes = result.meta?.changes ?? null;
    const lastRowId = result.meta?.last_row_id ?? null;
    return {
      type: "command",
      columns: [],
      rows: [],
      rowCount: changes ?? 0,
      meta: {
        durationMs: Date.now() - startedAt,
        changes,
        lastRowId,
      },
    };
  } catch (error) {
    throw new SqlExecutionError(getErrorMessage(error), error);
  }
}

function quoteIdentifier(identifier: string): string {
  if (identifier.length === 0 || identifier.length > 128 || identifier.includes("\u0000")) {
    throw new SqlValidationError("表名长度无效");
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

function validateStructuredIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || value.length > 64) {
    throw new SqlValidationError(`${label}只能包含字母、数字和下划线，且必须以字母或下划线开头`);
  }
  return value;
}

export function isInternalTableName(name: string): boolean {
  const upper = (name || "").toUpperCase();
  return (
    upper.startsWith("SQLITE_") ||
    upper.startsWith("_CF") ||
    upper.startsWith("__CF_") ||
    upper.startsWith("__MINIFLARE") ||
    upper.startsWith("D1_") ||
    upper.startsWith("_D1_")
  );
}

function validateUserTableName(value: unknown, label: string): string {
  const name = validateStructuredIdentifier(value, label);
  if (isInternalTableName(name)) {
    throw new SqlValidationError("不能操作 D1 内部系统表");
  }
  return name;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SqlValidationError(`${label}必须是 JSON 对象`);
  }
  return value as Record<string, unknown>;
}

function getTableColumns(schema: { tables: SchemaTable[] } | { table: string; columns: SchemaColumn[] }): SchemaColumn[] {
  if (!("columns" in schema) || schema.columns.length === 0) {
    throw new SqlValidationError("数据表不存在或没有可操作的列");
  }
  return schema.columns;
}

async function requireTable(database: D1Database, table: unknown): Promise<{ name: string; columns: SchemaColumn[] }> {
  const name = validateUserTableName(table, "表名");
  const schema = await readSchema(database, name);
  return { name, columns: getTableColumns(schema) };
}

function getRecordValues(values: unknown, columns: SchemaColumn[]): { names: string[]; params: SqlParameter[] } {
  const object = asObject(values, "values");
  const knownColumns = new Set(columns.map((column) => column.name));
  const names = Object.keys(object);
  if (names.length === 0) {
    throw new SqlValidationError("values 不能为空");
  }
  if (names.length > 100) {
    throw new SqlValidationError("一次最多操作 100 个字段");
  }
  for (const name of names) {
    if (!knownColumns.has(name)) {
      throw new SqlValidationError(`字段不存在：${name}`);
    }
  }
  return { names, params: normalizeParameters(names.map((name) => object[name])) };
}

function pageNumber(value: unknown, fallback: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > maximum) {
    throw new SqlValidationError(`${label}必须是 0 到 ${maximum} 之间的整数`);
  }
  return value;
}

/** 按表名和分页参数读取记录，供可视化数据表格使用。 */
export async function listRecords(
  database: D1Database,
  table: unknown,
  limit?: unknown,
  offset?: unknown,
): Promise<SqlExecutionResult> {
  const { name } = await requireTable(database, table);
  const safeLimit = pageNumber(limit, 100, 500, "limit");
  const safeOffset = pageNumber(offset, 0, 1_000_000, "offset");
  return executeSql(
    database,
    { sql: `SELECT * FROM ${quoteIdentifier(name)} LIMIT ? OFFSET ?`, params: [safeLimit, safeOffset] },
    "normal",
  );
}

/** 读取数据表的全部记录，供客户端导出使用。 */
export async function exportRecords(
  database: D1Database,
  table: unknown,
): Promise<SqlExecutionResult> {
  const { name } = await requireTable(database, table);
  return executeSql(database, { sql: `SELECT * FROM ${quoteIdentifier(name)}` }, "normal");
}

/** 批量导入多条记录到指定数据表，使用参数绑定和事务批处理。 */
export async function importRecords(
  database: D1Database,
  table: unknown,
  records: unknown,
  role: AccessRole,
): Promise<{ count: number; meta: { durationMs: number } }> {
  const { name, columns } = await requireTable(database, table);
  if (!Array.isArray(records) || records.length === 0) {
    throw new SqlValidationError("导入数据必须是包含记录的 JSON 数组");
  }
  if (records.length > 5000) {
    throw new SqlValidationError("单次最多导入 5000 条记录");
  }

  const knownColumns = new Set(columns.map((c) => c.name));
  const statements: D1PreparedStatement[] = [];
  const startedAt = Date.now();

  for (let index = 0; index < records.length; index += 1) {
    const raw = records[index];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new SqlValidationError(`第 ${index + 1} 条记录必须是 JSON 对象`);
    }
    const item = raw as Record<string, unknown>;
    const keys = Object.keys(item).filter((key) => knownColumns.has(key) && item[key] !== "" && item[key] !== undefined && item[key] !== null);
    if (keys.length === 0) {
      continue;
    }
    const quotedKeys = keys.map(quoteIdentifier).join(", ");
    const placeholders = keys.map(() => "?").join(", ");
    const params = normalizeParameters(keys.map((key) => item[key]));
    const sql = `INSERT INTO ${quoteIdentifier(name)} (${quotedKeys}) VALUES (${placeholders})`;
    statements.push(database.prepare(sql).bind(...params));
  }

  if (statements.length === 0) {
    throw new SqlValidationError("没有匹配到当前数据表的有效字段数据");
  }

  const batchSize = 100;
  for (let i = 0; i < statements.length; i += batchSize) {
    const chunk = statements.slice(i, i + batchSize);
    try {
      await database.batch(chunk);
    } catch (error) {
      throw new SqlExecutionError(`导入在第 ${i + 1} 批次执行失败: ${getErrorMessage(error)}`, error);
    }
  }

  return {
    count: statements.length,
    meta: { durationMs: Date.now() - startedAt },
  };
}

/** 通过结构化字段创建一条记录，不要求页面用户编写 SQL。 */
export async function createRecord(
  database: D1Database,
  table: unknown,
  values: unknown,
  role: AccessRole,
): Promise<SqlExecutionResult> {
  const { name, columns } = await requireTable(database, table);
  const record = getRecordValues(values, columns);
  const quotedNames = record.names.map(quoteIdentifier).join(", ");
  const placeholders = record.names.map(() => "?").join(", ");
  return executeSql(
    database,
    { sql: `INSERT INTO ${quoteIdentifier(name)} (${quotedNames}) VALUES (${placeholders})`, params: record.params },
    role,
  );
}

function requirePrimaryKey(columns: SchemaColumn[], primaryKey: unknown): string {
  const name = validateStructuredIdentifier(primaryKey, "主键字段");
  const column = columns.find((candidate) => candidate.name === name && candidate.pk > 0);
  if (!column) {
    throw new SqlValidationError("当前表没有这个主键字段，无法定位记录");
  }
  return name;
}

/** 通过主键更新一条记录，主键字段本身不参与修改。 */
export async function updateRecord(
  database: D1Database,
  table: unknown,
  primaryKey: unknown,
  primaryKeyValue: unknown,
  values: unknown,
  role: AccessRole,
): Promise<SqlExecutionResult> {
  const { name, columns } = await requireTable(database, table);
  const key = requirePrimaryKey(columns, primaryKey);
  const record = getRecordValues(values, columns);
  if (record.names.includes(key)) {
    throw new SqlValidationError("主键字段不能在编辑操作中修改");
  }
  const assignments = record.names.map((column) => `${quoteIdentifier(column)} = ?`).join(", ");
  const isNullKey = primaryKeyValue === null || primaryKeyValue === undefined;
  const sql = isNullKey
    ? `UPDATE ${quoteIdentifier(name)} SET ${assignments} WHERE ${quoteIdentifier(key)} IS NULL`
    : `UPDATE ${quoteIdentifier(name)} SET ${assignments} WHERE ${quoteIdentifier(key)} = ?`;
  const params = isNullKey
    ? record.params
    : [...record.params, ...normalizeParameters([primaryKeyValue])];
  const result = await executeSql(database, { sql, params }, role);
  if ((result.meta?.changes ?? result.rowCount ?? 0) === 0) {
    throw new SqlValidationError("没有匹配到可更新的记录（未影响任何数据）");
  }
  return result;
}

/** 通过主键删除一条记录；该操作仍属于普通密码允许的 CRUD。 */
export async function deleteRecord(
  database: D1Database,
  table: unknown,
  primaryKey: unknown,
  primaryKeyValue: unknown,
  role: AccessRole,
): Promise<SqlExecutionResult> {
  const { name, columns } = await requireTable(database, table);
  const key = requirePrimaryKey(columns, primaryKey);
  const isNullKey = primaryKeyValue === null || primaryKeyValue === undefined;
  const sql = isNullKey
    ? `DELETE FROM ${quoteIdentifier(name)} WHERE ${quoteIdentifier(key)} IS NULL`
    : `DELETE FROM ${quoteIdentifier(name)} WHERE ${quoteIdentifier(key)} = ?`;
  const params = isNullKey ? [] : normalizeParameters([primaryKeyValue]);
  const result = await executeSql(database, { sql, params }, role);
  if ((result.meta?.changes ?? result.rowCount ?? 0) === 0) {
    throw new SqlValidationError("没有匹配到可删除的记录（未影响任何数据）");
  }
  return result;
}

const COLUMN_TYPES = new Set(["TEXT", "INTEGER", "REAL", "BLOB"]);

/** 使用受限字段定义创建数据表；普通和 admin 角色都可以创建。 */
export async function createTable(
  database: D1Database,
  definition: { name: unknown; columns: unknown },
  role: AccessRole,
): Promise<SqlExecutionResult> {
  const name = validateUserTableName(definition.name, "表名");
  if (!Array.isArray(definition.columns) || definition.columns.length === 0 || definition.columns.length > 50) {
    throw new SqlValidationError("数据表必须包含 1 到 50 个字段");
  }

  let primaryKeyCount = 0;
  const definitions = definition.columns.map((value, index) => {
    const column = asObject(value, `columns[${index}]`);
    const columnName = validateStructuredIdentifier(column.name, `columns[${index}].name`);
    if (typeof column.type !== "string" || !COLUMN_TYPES.has(column.type.toUpperCase())) {
      throw new SqlValidationError(`columns[${index}].type 必须是 TEXT、INTEGER、REAL 或 BLOB`);
    }
    const type = column.type.toUpperCase();
    const primaryKey = column.primaryKey === true;
    const notNull = column.notNull === true;
    if (primaryKey) primaryKeyCount += 1;
    if (primaryKeyCount > 1) {
      throw new SqlValidationError("可视化建表暂只支持一个主键字段");
    }
    return `${quoteIdentifier(columnName)} ${type}${primaryKey ? " PRIMARY KEY" : ""}${notNull || primaryKey ? " NOT NULL" : ""}`;
  });

  // 该 DDL 已由本函数按受限字段定义生成，普通和 admin 都允许执行。
  return executeSql(database, { sql: `CREATE TABLE ${quoteIdentifier(name)} (${definitions.join(", ")})` }, role);
}

/** 删除一张数据表，仅 admin 角色可以调用。 */
export async function dropTable(database: D1Database, table: unknown, role: AccessRole): Promise<SqlExecutionResult> {
  if (role !== "admin") {
    throw new SqlValidationError("只有 admin 密码可以删除数据表");
  }
  const name = validateUserTableName(table, "表名");
  return executeSql(database, { sql: `DROP TABLE ${quoteIdentifier(name)}` }, role);
}

/** 读取可视化页面所需的表清单或指定表的列定义，表名始终按标识符转义。 */
export async function readSchema(database: D1Database, table?: string): Promise<
  { tables: SchemaTable[] } | { table: string; columns: SchemaColumn[] }
> {
  try {
    if (table === undefined) {
      const result = await database
        .prepare(
          "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '__cf_%' AND name NOT LIKE '__miniflare_%' AND name NOT LIKE 'd1_%' ORDER BY type, name",
        )
        .all<SchemaTable>();
      const rows = (result.results ?? []) as SchemaTable[];
      return { tables: rows.filter((item) => item && item.name && !isInternalTableName(item.name)) };
    }

    const name = validateUserTableName(table, "表名");
    // D1 禁止直接执行 PRAGMA，且部分 D1 运行时不接受表值函数参数绑定；
    // 表名已通过严格标识符校验，因此可以安全地放入 SQL 字符串字面量。
    const result = await database
      .prepare(`SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info('${name.replace(/'/g, "''")}')`)
      .all<SchemaColumn>();
    return { table: name, columns: (result.results ?? []) as SchemaColumn[] };
  } catch (error) {
    if (error instanceof SqlValidationError) {
      throw error;
    }
    throw new SqlExecutionError(getErrorMessage(error), error);
  }
}
