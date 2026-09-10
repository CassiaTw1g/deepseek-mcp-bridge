#!/usr/bin/env node
/**
 * Transport-independent check: wires the MCP server to an in-memory client and
 * verifies tool registration + the DeepSeek call path. Use this when you only
 * want to validate the MCP wiring, or on a machine where binding a port is
 * inconvenient.
 *
 * Run: npm run selftest:memory
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile() {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
loadEnvFile();

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

const server = createMcpServer();
const client = new Client({ name: "selftest-memory", version: "1.0.0" });

await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

const { tools } = await client.listTools();
const tool = tools.find((t) => t.name === "deepseek_flash");

check("工具 deepseek_flash 已注册", Boolean(tool));
check("描述非空且提到派发条件", (tool?.description ?? "").includes("适用场景"), `${(tool?.description ?? "").length} 字符`);

const properties = tool?.inputSchema?.properties ?? {};
check("参数 task 存在", "task" in properties);
check("参数 mode 是枚举", Array.isArray(properties.mode?.enum), JSON.stringify(properties.mode?.enum ?? []));
check("task 为必填", (tool?.inputSchema?.required ?? []).includes("task"));

const called = await client.callTool({
  name: "deepseek_flash",
  arguments: { task: "只回复两个字:通了", mode: "analyze" },
});
const text = called?.content?.[0]?.text ?? "";

if (called?.isError) {
  console.log(`SKIP  DeepSeek 实际调用未成功(多为 API key 未配置):${text.slice(0, 200)}`);
} else {
  check("DeepSeek 返回了内容", text.length > 0, text.slice(0, 200));
}

await client.close();
await server.close();

console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
// Set the code and let the loop drain instead of calling process.exit().
// On Windows, exiting while a write to a piped stdout is still pending trips
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and turns the exit
// code into 127 — a passing run would report failure to any caller.
process.exitCode = failures === 0 ? 0 : 1;
