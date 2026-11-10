import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const configPath = resolve(process.cwd(), "wrangler.jsonc");
const d1Id = process.env.D1_DATABASE_ID || process.env.DATABASE_ID;
const d1Name = process.env.D1_DATABASE_NAME || process.env.DATABASE_NAME || "cf-sql";

if (d1Id) {
  try {
    let content = readFileSync(configPath, "utf8");
    content = content.replace(/"database_name":\s*"[^"]*"/, `"database_name": "${d1Name}"`);
    content = content.replace(/"database_id":\s*"[^"]*"/, `"database_id": "${d1Id}"`);
    writeFileSync(configPath, content, "utf8");
    console.log(`[build] 已从环境变量安全注入 D1 数据库配置（数据库名: ${d1Name}）。`);
  } catch (error) {
    console.error("[build] 注入 D1 配置失败:", error);
    process.exit(1);
  }
} else {
  console.log("[build] 未检测到 D1_DATABASE_ID 环境变量，保持默认配置。");
}
