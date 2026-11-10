# CF SQL

一个运行在 Cloudflare Workers 上的 D1 HTTP SQL API，并附带单页可视化控制台。

## 功能

- `POST /api/auth/login`：使用普通密码或 admin 密码登录，签发 8 小时 HMAC 会话令牌。
- `POST /api/sql`：执行单条 SQL；普通用户支持查询、记录 CRUD 与建表，admin 用户开放全部 SQL 权限（包含删表、改表、创建索引等结构与管理操作）。
- `POST /api/schema`：读取数据表和列定义，供控制台浏览数据库结构。
- 可视化操作接口：`/api/tables/list`、`/api/tables/create`、`/api/tables/drop`，以及 `/api/records/list`、`/api/records/create`、`/api/records/update`、`/api/records/delete`。
- 导入导出接口：`/api/records/export`（全量数据导出）、`/api/records/import`（批量导入并参数化写入，支持 CSV/JSON 格式）。
- 页面会话保存在 `sessionStorage`，不会把密码写入浏览器存储。
- 普通密码可以执行查询、记录级 CRUD（`SELECT`、`INSERT`、`UPDATE`、`DELETE`、`REPLACE`），并可通过可视化页面新建数据表。
- admin 密码拥有全部权限（可执行任意支持的 SQL 语句与结构修改）。

页面默认使用上述可视化接口，不需要用户编写 SQL；`/api/sql` 保留给需要程序化调用的客户端。

## 本地运行

需要 Node.js 18+ 和 Wrangler。

```bash
npm install
npx wrangler d1 create cf-sql
```

把命令输出的数据库 UUID 替换到 `wrangler.jsonc` 的 `database_id`，然后准备本地密钥：

```bash
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，设置两套不同的强密码和至少 32 个字符的 AUTH_SECRET
npm run dev
```

启动后打开 Wrangler 输出的地址即可。本地开发默认使用本地 D1，不会因为远程 D1 网络问题卡住页面；部署 Worker 后会使用 `wrangler.jsonc` 绑定的真实 D1。首次进入控制台可用任一访问密码执行建表操作；项目没有预设业务表。

## 部署

先把 `wrangler.jsonc` 中的 `database_id` 换成真实 D1 数据库 UUID，再写入 Worker Secrets：

```bash
npx wrangler secret put SQL_NORMAL_PASSWORD
npx wrangler secret put SQL_ADMIN_PASSWORD
npx wrangler secret put AUTH_SECRET
npm run deploy
```

生产环境请使用 HTTPS，并严格限制拥有 admin 密码的人员。`AUTH_SECRET` 变化会使已有会话全部失效。

## API 示例

登录：

```bash
curl -X POST https://your-domain.example/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"password":"your-normal-password"}'
```

查询：

```bash
curl -X POST https://your-domain.example/api/sql \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer YOUR_TOKEN' \
  -d '{"sql":"SELECT * FROM users WHERE id = ?","params":[1]}'
```

通过 `/api/sql` 执行删表必须使用 admin 密码换取的令牌；普通和 admin 都可以执行建表及记录操作：

```bash
curl -X POST https://your-domain.example/api/sql \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer YOUR_ADMIN_TOKEN' \
  -d '{"sql":"CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)"}'
```

每个请求只允许一条语句；末尾分号可以保留。JSON 参数支持字符串、数字、布尔值和 `null`，推荐始终使用 `?` 占位符，避免拼接外部输入。

## 检查

```bash
npm run check
```
