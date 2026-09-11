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
import { createRegistry } from "../src/agent/jobs.ts";
import { createPolicy } from "../src/sandbox.ts";

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

// A stub runner: nothing here should ever reach the point of spawning a real
// job, because every agent assertion below is about the paths that get
// *rejected* before a job exists.
const registry = createRegistry(async () => ({ text: "stub", steps: 0 }), {
  stateDir: join(ROOT, ".state", "selftest"),
});
const policy = createPolicy([ROOT]);

const server = createMcpServer(registry, policy);
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

// --- agent 工具:注册与拒绝路径 -------------------------------------------
// 这里只验证「被拒绝」的一侧。放行的那一侧会真的启动子进程、真的花钱,
// 属于 npm run accept 的职责,不属于一个毫秒级的自检。

const agentStart = tools.find((t) => t.name === "deepseek_agent_start");
const agentPoll = tools.find((t) => t.name === "deepseek_agent_poll");
const startDesc = agentStart?.description ?? "";

check("工具 deepseek_agent_start 已注册", Boolean(agentStart));
check("工具 deepseek_agent_poll 已注册", Boolean(agentPoll));
check("start 描述写明了必须轮询", startDesc.includes("deepseek_agent_poll"));
check("start 描述警告不得编造结果", /不要向用户报告任何结论/.test(startDesc));
check("start 要求 workspace 参数", "workspace" in (agentStart?.inputSchema?.properties ?? {}));
// mode 曾经在这里但不能生效(harness 不读它)。参数面留着它,调用方就会照着它做计划。
check("start 不再暴露无效果的 mode 参数", !("mode" in (agentStart?.inputSchema?.properties ?? {})));

// 用一个在两个平台上都真的在范围外的路径。这里不能写 `C:\Windows`:
// 在 Linux 上那只是个带反斜杠的**相对名**,会被拼到允许根目录里面去,
// 于是它反而合法 —— 断言就变成了在检验一个错误的前提(CI 上就是这么挂的)。
const outside = resolve(ROOT, "..");
const denied = await client.callTool({
  name: "deepseek_agent_start",
  arguments: { task: "这一条不该被执行", workspace: outside },
});
const deniedText = denied?.content?.[0]?.text ?? "";
check("工作区越界时 start 返回错误", Boolean(denied?.isError), deniedText.replace(/\n/g, " ").slice(0, 120));
check("拒绝信息给出了原因", /工作区被拒绝|OUTSIDE/.test(deniedText));

await client.close();
await server.close();

console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
// Set the code and let the loop drain instead of calling process.exit().
// On Windows, exiting while a write to a piped stdout is still pending trips
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and turns the exit
// code into 127 — a passing run would report failure to any caller.
process.exitCode = failures === 0 ? 0 : 1;
