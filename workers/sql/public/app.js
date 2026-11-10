const SESSION_KEY = "cf-sql-session";
const THEME_KEY = "cf-sql-theme";

const state = {
  session: loadSession(),
  tables: [],
  activeTable: null,
  columns: [],
  records: [],
  editingRecord: null,
  parsedImportRows: [],
  lastSqlResult: null,
  toastTimer: null,
};

const elements = {
  loginScreen: document.querySelector("#login-screen"),
  consoleScreen: document.querySelector("#console-screen"),
  loginForm: document.querySelector("#login-form"),
  loginButton: document.querySelector("#login-button"),
  loginLabel: document.querySelector("#login-label"),
  loginSpinner: document.querySelector("#login-spinner"),
  loginError: document.querySelector("#login-error"),
  passwordInput: document.querySelector("#password-input"),
  togglePassword: document.querySelector("#toggle-password"),
  logoutButton: document.querySelector("#logout-button"),
  themeToggle: document.querySelector("#theme-toggle"),
  roleLabel: document.querySelector("#role-label"),
  workspaceSubtitle: document.querySelector("#workspace-subtitle"),
  refreshSchema: document.querySelector("#refresh-schema"),
  tableSearch: document.querySelector("#table-search"),
  tableList: document.querySelector("#table-list"),
  tableEmpty: document.querySelector("#table-empty"),
  sqlCommandForm: document.querySelector("#sql-command-form"),
  sqlCommandInput: document.querySelector("#sql-command-input"),
  executeSqlButton: document.querySelector("#execute-sql-button"),
  sqlResultPanel: document.querySelector("#sql-result-panel"),
  sqlResultSummary: document.querySelector("#sql-result-summary"),
  sqlResultContent: document.querySelector("#sql-result-content"),
  exportSqlButton: document.querySelector("#export-sql-button"),
  createTableButton: document.querySelector("#create-table-button"),
  welcomeCreateButton: document.querySelector("#welcome-create-button"),
  welcomePanel: document.querySelector("#welcome-panel"),
  tableWorkspace: document.querySelector("#table-workspace"),
  activeTableName: document.querySelector("#active-table-name"),
  tableRecordCount: document.querySelector("#table-record-count"),
  refreshRecords: document.querySelector("#refresh-records"),
  importRecordsButton: document.querySelector("#import-records-button"),
  exportRecordsButton: document.querySelector("#export-records-button"),
  addRecordButton: document.querySelector("#add-record-button"),
  dropTableButton: document.querySelector("#drop-table-button"),
  columnChips: document.querySelector("#column-chips"),
  primaryKeyHint: document.querySelector("#primary-key-hint"),
  recordsLoading: document.querySelector("#records-loading"),
  recordsEmpty: document.querySelector("#records-empty"),
  recordsTableWrap: document.querySelector("#records-table-wrap"),
  recordsTable: document.querySelector("#records-table"),
  recordDialog: document.querySelector("#record-dialog"),
  recordDialogTitle: document.querySelector("#record-dialog-title"),
  recordForm: document.querySelector("#record-form"),
  recordFields: document.querySelector("#record-fields"),
  recordFormError: document.querySelector("#record-form-error"),
  saveRecordButton: document.querySelector("#save-record-button"),
  tableDialog: document.querySelector("#table-dialog"),
  tableForm: document.querySelector("#table-form"),
  newTableName: document.querySelector("#new-table-name"),
  newColumnFields: document.querySelector("#new-column-fields"),
  addColumnButton: document.querySelector("#add-column-button"),
  saveTableButton: document.querySelector("#save-table-button"),
  tableFormError: document.querySelector("#table-form-error"),
  importDialog: document.querySelector("#import-dialog"),
  importForm: document.querySelector("#import-form"),
  importDropzone: document.querySelector("#import-dropzone"),
  importFileInput: document.querySelector("#import-file-input"),
  importFileName: document.querySelector("#import-file-name"),
  importPreviewBox: document.querySelector("#import-preview-box"),
  importPreviewSummary: document.querySelector("#import-preview-summary"),
  importPreviewTableWrap: document.querySelector("#import-preview-table-wrap"),
  importFormError: document.querySelector("#import-form-error"),
  submitImportButton: document.querySelector("#submit-import-button"),
  exportDialog: document.querySelector("#export-dialog"),
  exportCsvBtn: document.querySelector("#export-csv-btn"),
  exportJsonBtn: document.querySelector("#export-json-btn"),
  toast: document.querySelector("#toast"),
};

function loadSession() {
  try {
    const value = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null");
    if (value?.token && value?.expiresAt > Date.now()) return value;
  } catch {
    // 损坏的会话只影响本地 UI 状态，不阻止重新登录。
  }
  sessionStorage.removeItem(SESSION_KEY);
  return null;
}

function saveSession(session) {
  state.session = session;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  state.session = null;
  state.activeTable = null;
  state.columns = [];
  state.records = [];
  sessionStorage.removeItem(SESSION_KEY);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function setLoginError(message = "") {
  elements.loginError.textContent = message;
  elements.loginError.hidden = !message;
}

function setLoginLoading(loading) {
  elements.loginButton.disabled = loading;
  elements.loginSpinner.hidden = !loading;
  elements.loginLabel.textContent = loading ? "连接中…" : "进入控制台";
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set("content-type", "application/json");
  if (state.session?.token) headers.set("authorization", `Bearer ${state.session.token}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const requestOptions = { ...options, headers };
  if (!options.signal) requestOptions.signal = controller.signal;
  let response;
  try {
    response = await fetch(path, requestOptions);
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("请求超时，请检查 D1 连接或本地 Wrangler 模式。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  let data = null;
  try { data = await response.json(); } catch { /* 由状态码提供错误信息。 */ }
  if (!response.ok) {
    if (response.status === 401 && state.session) {
      clearSession();
      showLogin();
    }
    throw new Error(data?.error?.details ? `${data.error.message}：${data.error.details}` : data?.error?.message ?? `请求失败（${response.status}）`);
  }
  return data;
}

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", isError);
  elements.toast.classList.add("show");
  if (state.toastTimer) clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 3500);
}

function renderSqlResult(result) {
  state.lastSqlResult = result;
  elements.sqlResultPanel.hidden = false;
  elements.sqlResultContent.replaceChildren();
  if (result.type !== "rows") {
    if (elements.exportSqlButton) elements.exportSqlButton.hidden = true;
    const changes = result.meta?.changes ?? result.rowCount ?? 0;
    elements.sqlResultSummary.textContent = `执行成功 · 影响 ${changes} 行`;
    const message = document.createElement("p");
    message.className = "sql-result-message";
    message.textContent = "SQL 执行成功。";
    elements.sqlResultContent.append(message);
    return;
  }

  const rows = Array.isArray(result.rows) ? result.rows : [];
  const columns = Array.isArray(result.columns) && result.columns.length > 0
    ? result.columns
    : rows.flatMap((row) => Object.keys(row)).filter((column, index, values) => values.indexOf(column) === index);
  elements.sqlResultSummary.textContent = `查询完成 · ${result.rowCount ?? rows.length} 行`;
  if (elements.exportSqlButton) elements.exportSqlButton.hidden = rows.length === 0;
  if (rows.length === 0 || columns.length === 0) {
    const message = document.createElement("p");
    message.className = "sql-result-message";
    message.textContent = "查询成功，没有返回记录。";
    elements.sqlResultContent.append(message);
    return;
  }

  const table = document.createElement("table");
  table.className = "sql-result-table";
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const column of columns) {
    const cell = document.createElement("th");
    cell.textContent = column;
    headerRow.append(cell);
  }
  head.append(headerRow);
  const body = document.createElement("tbody");
  for (const row of rows) {
    const rowElement = document.createElement("tr");
    for (const column of columns) {
      const cell = document.createElement("td");
      const value = formatValue(row[column]);
      cell.textContent = value.text;
      if (value.className) cell.classList.add(value.className);
      cell.title = value.text;
      rowElement.append(cell);
    }
    body.append(rowElement);
  }
  table.append(head, body);
  elements.sqlResultContent.append(table);
}

function renderSqlError(error) {
  state.lastSqlResult = null;
  if (elements.exportSqlButton) elements.exportSqlButton.hidden = true;
  elements.sqlResultPanel.hidden = false;
  elements.sqlResultSummary.textContent = "执行失败";
  elements.sqlResultContent.replaceChildren();
  const message = document.createElement("p");
  message.className = "sql-result-message sql-result-error";
  message.textContent = errorText(error);
  elements.sqlResultContent.append(message);
}

async function executeSqlCommand(event) {
  event.preventDefault();
  const sql = elements.sqlCommandInput.value.trim();
  if (!sql) {
    renderSqlError(new Error("请输入 SQL 语句。"));
    elements.sqlCommandInput.focus();
    return;
  }
  elements.executeSqlButton.disabled = true;
  elements.executeSqlButton.textContent = "执行中…";
  try {
    const result = await api("/api/sql", { method: "POST", body: JSON.stringify({ sql }) });
    renderSqlResult(result);
    showToast(result.type === "rows" ? "SQL 查询完成" : "SQL 执行成功");
    if (result.type !== "rows") await loadTables();
  } catch (error) {
    renderSqlError(error);
    showToast(errorText(error), true);
  } finally {
    elements.executeSqlButton.disabled = false;
    elements.executeSqlButton.textContent = "执行 SQL";
  }
}

function closeDialog(dialog) {
  if (dialog.open) dialog.close();
}

function showConsole() {
  elements.loginScreen.hidden = true;
  elements.consoleScreen.hidden = false;
  const isAdmin = state.session?.role === "admin";
  elements.roleLabel.textContent = isAdmin ? "admin 访问" : "普通访问";
  elements.workspaceSubtitle.textContent = isAdmin
    ? "admin 会话已就绪，拥有全部权限（可执行任意 SQL、管理表结构与记录）。"
    : "普通会话已就绪，可以新建数据表并完成记录级增删改查。";
  elements.createTableButton.disabled = false;
  elements.welcomeCreateButton.disabled = false;
  elements.createTableButton.title = "创建数据表（普通和 admin 均可）";
  elements.welcomeCreateButton.title = "创建数据表（普通和 admin 均可）";
  loadTables();
}

function showLogin() {
  elements.consoleScreen.hidden = true;
  elements.loginScreen.hidden = false;
  elements.passwordInput.focus();
}

function escapeIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function isInternalTableName(name) {
  const upper = String(name || "").toUpperCase();
  return (
    upper.startsWith("SQLITE_") ||
    upper.startsWith("_CF") ||
    upper.startsWith("__CF_") ||
    upper.startsWith("__MINIFLARE") ||
    upper.startsWith("D1_") ||
    upper.startsWith("_D1_")
  );
}

function getPrimaryKey() {
  const keys = state.columns.filter((column) => column.pk > 0);
  return keys.length === 1 ? keys[0] : null;
}

function renderTableList() {
  const search = elements.tableSearch.value.trim().toLowerCase();
  const tables = state.tables.filter((table) => table.name.toLowerCase().includes(search));
  elements.tableList.replaceChildren();
  elements.tableEmpty.hidden = state.tables.length > 0 || search.length > 0;
  if (state.tables.length === 0 || tables.length === 0) {
    if (state.tables.length > 0) {
      const empty = document.createElement("div");
      empty.className = "small-empty";
      empty.textContent = "没有匹配的数据表";
      elements.tableList.append(empty);
    }
    return;
  }

  for (const table of tables) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `table-item${state.activeTable === table.name ? " active" : ""}`;
    const icon = document.createElement("span");
    icon.className = "table-kind";
    icon.textContent = table.type === "view" ? "◈" : "▦";
    const name = document.createElement("span");
    name.className = "table-name";
    name.textContent = table.name;
    item.append(icon, name);
    item.addEventListener("click", () => selectTable(table.name));
    elements.tableList.append(item);
  }
}

async function loadTables() {
  elements.refreshSchema.disabled = true;
  try {
    const data = await api("/api/tables/list", { method: "POST", body: "{}" });
    const rawTables = Array.isArray(data.tables) ? data.tables : [];
    state.tables = rawTables.filter((table) => !isInternalTableName(table.name));
    renderTableList();
    if (state.tables.length === 0) {
      state.activeTable = null;
      elements.welcomePanel.hidden = false;
      elements.tableWorkspace.hidden = true;
      return;
    }
    const active = state.tables.some((table) => table.name === state.activeTable) ? state.activeTable : state.tables[0].name;
    await selectTable(active);
  } catch (error) {
    showToast(errorText(error), true);
  } finally {
    elements.refreshSchema.disabled = false;
  }
}

async function selectTable(tableName) {
  state.activeTable = tableName;
  renderTableList();
  elements.welcomePanel.hidden = true;
  elements.tableWorkspace.hidden = false;
  elements.activeTableName.textContent = tableName;
  await loadTableData();
}

async function loadTableData() {
  if (!state.activeTable) return;
  elements.recordsLoading.hidden = false;
  elements.recordsEmpty.hidden = true;
  elements.recordsTableWrap.hidden = true;
  elements.refreshRecords.disabled = true;
  try {
    const [schema, result] = await Promise.all([
      api("/api/schema", { method: "POST", body: JSON.stringify({ table: state.activeTable }) }),
      api("/api/records/list", { method: "POST", body: JSON.stringify({ table: state.activeTable, limit: 100, offset: 0 }) }),
    ]);
    state.columns = Array.isArray(schema.columns) ? schema.columns : [];
    state.records = Array.isArray(result.rows) ? result.rows : [];
    renderColumnSummary();
    renderRecords(result);
  } catch (error) {
    state.records = [];
    elements.tableRecordCount.textContent = "加载失败";
    showToast(errorText(error), true);
  } finally {
    elements.recordsLoading.hidden = true;
    elements.refreshRecords.disabled = false;
  }
}

function renderColumnSummary() {
  elements.columnChips.replaceChildren();
  for (const column of state.columns) {
    const chip = document.createElement("span");
    chip.className = "column-chip";
    chip.textContent = `${column.name} · ${column.type || "任意"}${column.pk ? " · 主键" : ""}`;
    elements.columnChips.append(chip);
  }
  const primaryKey = getPrimaryKey();
  elements.primaryKeyHint.textContent = primaryKey
    ? `主键：${primaryKey.name} · 可编辑和删除记录`
    : "未检测到单一主键 · 编辑和删除记录不可用";
  elements.addRecordButton.disabled = state.columns.length === 0;
  elements.dropTableButton.disabled = state.session?.role !== "admin";
  elements.dropTableButton.title = state.session?.role === "admin" ? "删除数据表" : "需要 admin 密码";
}

function formatValue(value) {
  if (value === null || value === undefined) return { text: "NULL", className: "null-value" };
  if (typeof value === "number") return { text: String(value), className: "number-value" };
  if (typeof value === "object") {
    try { return { text: JSON.stringify(value), className: "" }; } catch { return { text: "[无法显示]", className: "null-value" }; }
  }
  return { text: String(value), className: "" };
}

function renderRecords(result) {
  elements.tableRecordCount.textContent = `${result.rowCount ?? state.records.length} 条记录`;
  if (state.records.length === 0) {
    elements.recordsEmpty.hidden = false;
    elements.recordsTableWrap.hidden = true;
    return;
  }

  elements.recordsEmpty.hidden = true;
  elements.recordsTableWrap.hidden = false;
  const head = elements.recordsTable.querySelector("thead");
  const body = elements.recordsTable.querySelector("tbody");
  head.replaceChildren();
  body.replaceChildren();
  const headerRow = document.createElement("tr");
  for (const column of state.columns) {
    const cell = document.createElement("th");
    cell.textContent = column.name;
    headerRow.append(cell);
  }
  const actionHeader = document.createElement("th");
  actionHeader.className = "actions-column";
  actionHeader.textContent = "操作";
  headerRow.append(actionHeader);
  head.append(headerRow);

  const primaryKey = getPrimaryKey();
  for (const record of state.records) {
    const row = document.createElement("tr");
    for (const column of state.columns) {
      const cell = document.createElement("td");
      const value = formatValue(record[column.name]);
      cell.textContent = value.text;
      if (value.className) cell.classList.add(value.className);
      cell.title = value.text;
      row.append(cell);
    }
    const actions = document.createElement("td");
    actions.className = "row-actions";
    if (primaryKey && record[primaryKey.name] !== undefined) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "row-action edit-action";
      edit.textContent = "编辑";
      edit.addEventListener("click", () => openRecordDialog(record));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "row-action delete-action";
      remove.textContent = "删除";
      remove.addEventListener("click", () => removeRecord(record));
      actions.append(edit, remove);
    } else {
      const noKey = document.createElement("span");
      noKey.className = "no-key-label";
      noKey.textContent = "无主键";
      actions.append(noKey);
    }
    row.append(actions);
    body.append(row);
  }
}

function setFormError(element, message = "") {
  element.textContent = message;
  element.hidden = !message;
}

function openRecordDialog(record = null) {
  state.editingRecord = record;
  setFormError(elements.recordFormError);
  elements.recordDialogTitle.textContent = record ? "编辑记录" : "新增记录";
  elements.saveRecordButton.textContent = record ? "保存修改" : "保存记录";
  elements.recordFields.replaceChildren();
  const primaryKey = getPrimaryKey();
  for (const column of state.columns) {
    const isPk = column.pk > 0;
    const isIntegerPk = isPk && column.type?.toUpperCase() === "INTEGER";
    const wrapper = document.createElement("label");
    wrapper.className = "form-field";
    const fieldHead = document.createElement("span");
    fieldHead.className = "form-field-head";
    const fieldName = document.createElement("strong");
    fieldName.textContent = column.name;
    const fieldType = document.createElement("small");
    fieldType.textContent = `${column.type || "任意"}${isPk ? " · 主键" : ""}`;
    fieldHead.append(fieldName, fieldType);
    const input = document.createElement("input");
    input.className = "form-input record-input";
    input.type = "text";
    input.dataset.column = column.name;
    if (record) {
      input.placeholder = `输入 ${column.name}`;
      if (record[column.name] !== null && record[column.name] !== undefined) {
        input.value = String(record[column.name]);
      }
      if (primaryKey?.name === column.name) {
        input.disabled = true;
        if (record[column.name] === null || record[column.name] === undefined) {
          input.placeholder = "NULL（主键不可编辑）";
        }
      }
    } else {
      if (isIntegerPk) {
        input.placeholder = "留空自动生成（自增）或输入整数";
        input.required = false;
      } else if (isPk) {
        input.placeholder = `请输入主键 ${column.name}`;
        input.required = true;
      } else {
        input.placeholder = `输入 ${column.name}`;
        if (column.notnull) input.required = true;
      }
    }
    wrapper.append(fieldHead, input);
    elements.recordFields.append(wrapper);
  }
  elements.recordDialog.showModal();
}

function collectRecordValues() {
  const values = {};
  for (const input of elements.recordFields.querySelectorAll(".record-input")) {
    if (input.disabled) continue;
    if (!state.editingRecord && input.value === "" && !input.required) continue;
    values[input.dataset.column] = input.value;
  }
  return values;
}

async function saveRecord(event) {
  event.preventDefault();
  if (!state.activeTable) return;
  const values = collectRecordValues();
  if (Object.keys(values).length === 0) {
    setFormError(elements.recordFormError, "请至少填写一个字段。");
    return;
  }
  elements.saveRecordButton.disabled = true;
  try {
    const primaryKey = getPrimaryKey();
    if (state.editingRecord) {
      if (!primaryKey) throw new Error("当前表没有单一主键，无法编辑记录。");
      await api("/api/records/update", {
        method: "POST",
        body: JSON.stringify({
          table: state.activeTable,
          primaryKey: primaryKey.name,
          primaryKeyValue: state.editingRecord[primaryKey.name] ?? null,
          values,
        }),
      });
      showToast("记录已更新");
    } else {
      await api("/api/records/create", { method: "POST", body: JSON.stringify({ table: state.activeTable, values }) });
      showToast("记录已新增");
    }
    closeDialog(elements.recordDialog);
    await loadTableData();
  } catch (error) {
    setFormError(elements.recordFormError, errorText(error));
  } finally {
    elements.saveRecordButton.disabled = false;
  }
}

async function removeRecord(record) {
  const primaryKey = getPrimaryKey();
  if (!primaryKey) {
    showToast("当前表没有单一主键，无法定位记录", true);
    return;
  }
  const pkVal = record[primaryKey.name];
  const displayVal = pkVal === null || pkVal === undefined ? "NULL" : String(pkVal);
  if (!window.confirm(`确定删除 ${primaryKey.name} = ${displayVal} 的记录吗？`)) return;
  try {
    await api("/api/records/delete", {
      method: "POST",
      body: JSON.stringify({
        table: state.activeTable,
        primaryKey: primaryKey.name,
        primaryKeyValue: pkVal ?? null,
      }),
    });
    showToast("记录已删除");
    await loadTableData();
  } catch (error) {
    showToast(errorText(error), true);
  }
}

function addColumnRow(defaults = {}) {
  const row = document.createElement("div");
  row.className = "new-column-row";
  const name = document.createElement("input");
  name.className = "form-input column-name-input";
  name.placeholder = "字段名";
  name.value = defaults.name ?? "";
  name.pattern = "[A-Za-z_][A-Za-z0-9_]*";
  name.required = true;
  const type = document.createElement("select");
  type.className = "form-input column-type-input";
  for (const value of ["TEXT", "INTEGER", "REAL", "BLOB"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    option.selected = value === (defaults.type ?? "TEXT");
    type.append(option);
  }
  const pkLabel = document.createElement("label");
  pkLabel.className = "checkbox-label";
  const pk = document.createElement("input");
  pk.type = "checkbox";
  pk.className = "column-pk-input";
  pk.checked = defaults.primaryKey === true;
  pkLabel.append(pk, document.createTextNode("主键"));
  const requiredLabel = document.createElement("label");
  requiredLabel.className = "checkbox-label";
  const required = document.createElement("input");
  required.type = "checkbox";
  required.className = "column-required-input";
  required.checked = defaults.notNull === true;
  requiredLabel.append(required, document.createTextNode("必填"));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "icon-button remove-column-button";
  remove.textContent = "×";
  remove.title = "移除此字段";
  remove.addEventListener("click", () => {
    if (elements.newColumnFields.children.length > 1) row.remove();
  });
  row.append(name, type, pkLabel, requiredLabel, remove);
  elements.newColumnFields.append(row);
}

function openTableDialog() {
  setFormError(elements.tableFormError);
  elements.newTableName.value = "";
  elements.newColumnFields.replaceChildren();
  addColumnRow({ name: "id", type: "INTEGER", primaryKey: true, notNull: true });
  addColumnRow({ name: "name", type: "TEXT" });
  elements.tableDialog.showModal();
}

async function saveTable(event) {
  event.preventDefault();
  const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const tableName = elements.newTableName.value.trim();
  if (!identifierPattern.test(tableName)) {
    setFormError(elements.tableFormError, "请填写有效的表名（只能使用字母、数字和下划线，且不能以数字开头）。");
    elements.newTableName.focus();
    return;
  }
  const columns = [...elements.newColumnFields.querySelectorAll(".new-column-row")].map((row) => ({
    name: row.querySelector(".column-name-input").value.trim(),
    type: row.querySelector(".column-type-input").value,
    primaryKey: row.querySelector(".column-pk-input").checked,
    notNull: row.querySelector(".column-required-input").checked,
  }));
  if (columns.some((column) => !column.name)) {
    setFormError(elements.tableFormError, "请填写所有字段名。");
    return;
  }
  if (columns.some((column) => !identifierPattern.test(column.name))) {
    setFormError(elements.tableFormError, "字段名只能使用字母、数字和下划线，且不能以数字开头。");
    return;
  }
  if (new Set(columns.map((column) => column.name.toLowerCase())).size !== columns.length) {
    setFormError(elements.tableFormError, "字段名不能重复。");
    return;
  }
  elements.saveTableButton.disabled = true;
  elements.saveTableButton.textContent = "创建中…";
  try {
    await api("/api/tables/create", { method: "POST", body: JSON.stringify({ name: tableName, columns }) });
    closeDialog(elements.tableDialog);
    showToast("数据表已创建");
    await loadTables();
  } catch (error) {
    setFormError(elements.tableFormError, errorText(error));
  } finally {
    elements.saveTableButton.disabled = false;
    elements.saveTableButton.textContent = "创建数据表";
  }
}

async function dropActiveTable() {
  if (state.session?.role !== "admin") {
    showToast("只有 admin 密码可以删除数据表", true);
    return;
  }
  if (!state.activeTable || !window.confirm(`确定删除数据表“${state.activeTable}”及其中的全部记录吗？此操作不可恢复。`)) return;
  elements.dropTableButton.disabled = true;
  try {
    await api("/api/tables/drop", { method: "POST", body: JSON.stringify({ table: state.activeTable }) });
    showToast("数据表已删除");
    state.activeTable = null;
    await loadTables();
  } catch (error) {
    showToast(errorText(error), true);
    elements.dropTableButton.disabled = false;
  }
}

function updateThemeIcon() {
  const isLight = document.body.dataset.theme === "light";
  if (elements.themeToggle) {
    elements.themeToggle.title = isLight ? "切换为深色模式" : "切换为浅色模式";
    elements.themeToggle.setAttribute("aria-label", isLight ? "切换为深色模式" : "切换为浅色模式");
    elements.themeToggle.innerHTML = isLight
      ? '<svg class="icon icon-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>'
      : '<svg class="icon icon-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.5" /><path d="M12 2.5v2M12 19.5v2M4.8 4.8l1.4 1.4M17.8 17.8l1.4 1.4M2.5 12h2M19.5 12h2M4.8 19.2l1.4-1.4M17.8 6.2l1.4-1.4" /></svg>';
  }
}

function applyTheme() {
  if (localStorage.getItem(THEME_KEY) === "light") {
    document.body.dataset.theme = "light";
  } else {
    delete document.body.dataset.theme;
  }
  updateThemeIcon();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function exportToCsv(filename, rows, columns) {
  const headerLine = columns.map((col) => `"${String(col).replace(/"/g, '""')}"`).join(",");
  const dataLines = rows.map((row) => {
    return columns.map((col) => {
      const val = row[col];
      if (val === null || val === undefined) return "";
      const str = typeof val === "object" ? JSON.stringify(val) : String(val);
      return `"${str.replace(/"/g, '""')}"`;
    }).join(",");
  });
  const csvContent = "\uFEFF" + [headerLine, ...dataLines].join("\r\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  downloadBlob(blob, filename);
}

function exportToJson(filename, rows) {
  const jsonContent = JSON.stringify(rows, null, 2);
  const blob = new Blob([jsonContent], { type: "application/json;charset=utf-8;" });
  downloadBlob(blob, filename);
}

async function handleExportTable(format) {
  if (!state.activeTable) return;
  try {
    const data = await api("/api/records/export", {
      method: "POST",
      body: JSON.stringify({ table: state.activeTable }),
    });
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const columns = state.columns.map((c) => c.name);
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `${state.activeTable}_${dateStr}.${format}`;
    if (format === "csv") {
      exportToCsv(filename, rows, columns);
    } else {
      exportToJson(filename, rows);
    }
    closeDialog(elements.exportDialog);
    showToast(`数据已成功导出为 ${format.toUpperCase()}`);
  } catch (error) {
    showToast(errorText(error), true);
  }
}

function handleExportSqlResult() {
  if (!state.lastSqlResult || state.lastSqlResult.type !== "rows") return;
  const rows = Array.isArray(state.lastSqlResult.rows) ? state.lastSqlResult.rows : [];
  if (rows.length === 0) {
    showToast("没有可导出的查询数据", true);
    return;
  }
  const columns = Array.isArray(state.lastSqlResult.columns) && state.lastSqlResult.columns.length > 0
    ? state.lastSqlResult.columns
    : Object.keys(rows[0] || {});
  const filename = `sql_query_${new Date().toISOString().slice(0, 10)}.csv`;
  exportToCsv(filename, rows, columns);
  showToast("查询结果已导出为 CSV");
}

function parseCsvText(text) {
  const rows = [];
  let currentRow = [];
  let currentField = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (char === '"') {
        if (next === '"') {
          currentField += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i += 1;
          continue;
        }
      } else {
        currentField += char;
        i += 1;
        continue;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i += 1;
        continue;
      } else if (char === ',') {
        currentRow.push(currentField.trim());
        currentField = "";
        i += 1;
        continue;
      } else if (char === '\r') {
        if (next === '\n') i += 1;
        currentRow.push(currentField.trim());
        currentField = "";
        if (currentRow.some((c) => c.length > 0)) rows.push(currentRow);
        currentRow = [];
        i += 1;
        continue;
      } else if (char === '\n') {
        currentRow.push(currentField.trim());
        currentField = "";
        if (currentRow.some((c) => c.length > 0)) rows.push(currentRow);
        currentRow = [];
        i += 1;
        continue;
      } else {
        currentField += char;
        i += 1;
        continue;
      }
    }
  }
  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some((c) => c.length > 0)) rows.push(currentRow);
  }
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.replace(/^["']|["']$/g, '').trim());
  const data = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      if (headers[c]) {
        obj[headers[c]] = row[c] !== undefined ? row[c] : "";
      }
    }
    data.push(obj);
  }
  return data;
}

function parseJsonText(text) {
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.rows)) return parsed.rows;
    if (Array.isArray(parsed.data)) return parsed.data;
    if (Array.isArray(parsed.results)) return parsed.results;
  }
  throw new Error("JSON 内容必须是对象数组，例如 [ { \"name\": \"val\" }, ... ]");
}

function processImportText(rawText, filename) {
  setFormError(elements.importFormError);
  state.parsedImportRows = [];
  elements.submitImportButton.disabled = true;
  elements.importPreviewBox.hidden = true;
  elements.importFileName.textContent = filename || "已读取文件";

  const text = rawText.trim();
  if (!text) {
    setFormError(elements.importFormError, "文件内容为空。");
    return;
  }

  let parsed = [];
  try {
    if (text.startsWith("[") || text.startsWith("{")) {
      parsed = parseJsonText(text);
    } else {
      parsed = parseCsvText(text);
    }
  } catch (err) {
    setFormError(elements.importFormError, `文件解析失败：${errorText(err)}`);
    return;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    setFormError(elements.importFormError, "未能从文件中解析出有效数据行（如果是 CSV，请确保包含表头行）。");
    return;
  }

  const tableColNames = state.columns.map((c) => c.name);
  const sample = parsed[0] || {};
  const matchedCols = Object.keys(sample).filter((k) => tableColNames.includes(k));
  if (matchedCols.length === 0) {
    setFormError(elements.importFormError, `未找到与当前表（${state.activeTable}）相匹配的列名。当前表包含字段：${tableColNames.join(", ")}`);
    return;
  }

  state.parsedImportRows = parsed;
  elements.importPreviewSummary.textContent = `共 ${parsed.length} 行 · 匹配到 ${matchedCols.length} 个字段 (${matchedCols.join(", ")})`;
  
  const previewRows = parsed.slice(0, 3);
  const table = document.createElement("table");
  const head = document.createElement("thead");
  const tr = document.createElement("tr");
  for (const col of matchedCols) {
    const th = document.createElement("th");
    th.textContent = col;
    tr.append(th);
  }
  head.append(tr);
  const body = document.createElement("tbody");
  for (const row of previewRows) {
    const rtr = document.createElement("tr");
    for (const col of matchedCols) {
      const td = document.createElement("td");
      td.textContent = row[col] !== undefined && row[col] !== null ? String(row[col]) : "";
      rtr.append(td);
    }
    body.append(rtr);
  }
  table.append(head, body);
  elements.importPreviewTableWrap.replaceChildren(table);
  elements.importPreviewBox.hidden = false;
  elements.submitImportButton.disabled = false;
}

function handleImportFileSelect(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    processImportText(e.target.result, file.name);
  };
  reader.onerror = () => {
    setFormError(elements.importFormError, "读取文件失败，请重试。");
  };
  reader.readAsText(file, "UTF-8");
}

function openImportDialog() {
  if (!state.activeTable) return;
  setFormError(elements.importFormError);
  state.parsedImportRows = [];
  elements.importFileInput.value = "";
  elements.importFileName.textContent = "未选择文件";
  elements.importPreviewBox.hidden = true;
  elements.importPreviewTableWrap.replaceChildren();
  elements.submitImportButton.disabled = true;
  elements.submitImportButton.textContent = "确认导入";
  elements.importDialog.showModal();
}

async function submitImport(event) {
  event.preventDefault();
  if (!state.activeTable || state.parsedImportRows.length === 0) return;
  elements.submitImportButton.disabled = true;
  elements.submitImportButton.textContent = "正在导入…";
  try {
    const res = await api("/api/records/import", {
      method: "POST",
      body: JSON.stringify({ table: state.activeTable, records: state.parsedImportRows }),
    });
    showToast(`成功导入 ${res.count} 条记录`);
    closeDialog(elements.importDialog);
    await loadTableData();
  } catch (error) {
    setFormError(elements.importFormError, errorText(error));
    elements.submitImportButton.disabled = false;
    elements.submitImportButton.textContent = "确认导入";
  }
}

function openExportDialog() {
  if (!state.activeTable) return;
  elements.exportDialog.showModal();
}

function toggleTheme() {
  const light = document.body.dataset.theme === "light";
  if (light) {
    delete document.body.dataset.theme;
    localStorage.setItem(THEME_KEY, "dark");
  } else {
    document.body.dataset.theme = "light";
    localStorage.setItem(THEME_KEY, "light");
  }
  updateThemeIcon();
}

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setLoginError();
  if (!elements.passwordInput.value) {
    setLoginError("请输入访问密码。");
    return;
  }
  setLoginLoading(true);
  try {
    const data = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ password: elements.passwordInput.value }) });
    saveSession({ token: data.token, role: data.role, expiresAt: data.expiresAt });
    elements.passwordInput.value = "";
    showConsole();
  } catch (error) {
    setLoginError(errorText(error));
  } finally {
    setLoginLoading(false);
  }
});

elements.togglePassword.addEventListener("click", () => {
  const visible = elements.passwordInput.type === "text";
  elements.passwordInput.type = visible ? "password" : "text";
  elements.togglePassword.title = visible ? "显示密码" : "隐藏密码";
  elements.togglePassword.setAttribute("aria-label", visible ? "显示密码" : "隐藏密码");
});
elements.logoutButton.addEventListener("click", () => { clearSession(); showLogin(); showToast("已安全退出"); });
elements.themeToggle.addEventListener("click", toggleTheme);
elements.refreshSchema.addEventListener("click", loadTables);
elements.tableSearch.addEventListener("input", renderTableList);
elements.sqlCommandForm.addEventListener("submit", executeSqlCommand);
elements.createTableButton.addEventListener("click", openTableDialog);
elements.welcomeCreateButton.addEventListener("click", openTableDialog);
elements.refreshRecords.addEventListener("click", loadTableData);
elements.importRecordsButton.addEventListener("click", openImportDialog);
elements.exportRecordsButton.addEventListener("click", openExportDialog);
if (elements.exportSqlButton) elements.exportSqlButton.addEventListener("click", handleExportSqlResult);
elements.addRecordButton.addEventListener("click", () => openRecordDialog());
elements.dropTableButton.addEventListener("click", dropActiveTable);
elements.recordForm.addEventListener("submit", saveRecord);
elements.tableForm.addEventListener("submit", saveTable);
elements.addColumnButton.addEventListener("click", () => addColumnRow());
elements.importForm.addEventListener("submit", submitImport);
elements.importDropzone.addEventListener("click", () => elements.importFileInput.click());
elements.importFileInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) handleImportFileSelect(file);
});
elements.importDropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  elements.importDropzone.classList.add("dragover");
});
elements.importDropzone.addEventListener("dragleave", () => {
  elements.importDropzone.classList.remove("dragover");
});
elements.importDropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  elements.importDropzone.classList.remove("dragover");
  const file = e.dataTransfer.files?.[0];
  if (file) handleImportFileSelect(file);
});
elements.exportCsvBtn.addEventListener("click", () => handleExportTable("csv"));
elements.exportJsonBtn.addEventListener("click", () => handleExportTable("json"));
for (const button of document.querySelectorAll("[data-close-dialog]")) {
  button.addEventListener("click", () => closeDialog(document.querySelector(`#${button.dataset.closeDialog}`)));
}

applyTheme();
if (state.session) showConsole(); else showLogin();
