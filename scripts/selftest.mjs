#!/usr/bin/env node
/**
 * End-to-end self test: starts the server, exercises the real MCP HTTP
 * endpoints, then shuts it down. Exits non-zero on failure.
 *
 * Run: npm run selftest
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readEnvFile() {
  const file = join(ROOT, ".env");
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

// Shell env wins over .env, matching selftest-memory.mjs and dotenv's own
// precedence — lets you override a single var for one run without editing .env.
const env = { ...readEnvFile(), ...process.env };
const PORT = env.PORT ?? "8787";
const SECRET = env.MCP_PATH_SECRET ?? "";
const MCP_URL = `http://127.0.0.1:${PORT}/mcp/${SECRET}`;
const HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** The transport replies as SSE, so unwrap the `data:` line. */
function parseBody(text) {
  const dataLine = text.split(/\r?\n/).find((l) => l.startsWith("data:"));
  const json = dataLine ? dataLine.slice(5).trim() : text.trim();
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function rpc(payload) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(payload),
  });
  return parseBody(await res.text());
}

const server = spawn(process.execPath, [join(ROOT, "src", "server.ts")], {
  cwd: ROOT,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

function shutdown(code) {
  try {
    server.kill();
  } catch {
    /* already gone */
  }
  process.exit(code);
}

await new Promise((res, rej) => {
  const timer = setTimeout(
    () => rej(new Error(`服务 10 秒内未启动。日志:\n${serverLog}`)),
    10_000,
  );
  const poll = setInterval(() => {
    if (serverLog.includes("listening")) {
      clearTimeout(timer);
      clearInterval(poll);
      res();
    }
  }, 100);
  server.on("exit", (code) => {
    clearTimeout(timer);
    clearInterval(poll);
    rej(new Error(`服务提前退出(code ${code})。日志:\n${serverLog}`));
  });
});

console.log("服务已启动,开始协议检查\n");

const bare = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
  method: "POST",
  headers: HEADERS,
  body: "{}",
});
check("裸 /mcp 返回 404", bare.status === 404, `实际 ${bare.status}`);

const wrong = await fetch(`http://127.0.0.1:${PORT}/mcp/${"x".repeat(64)}`, {
  method: "POST",
  headers: HEADERS,
  body: "{}",
});
check("错误 secret 返回 404", wrong.status === 404, `实际 ${wrong.status}`);

const init = await rpc({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "selftest", version: "1" },
  },
});
check(
  "initialize 成功",
  init?.result?.serverInfo?.name === "deepseek-bridge",
  JSON.stringify(init?.result?.serverInfo ?? init),
);

const tools = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
const names = (tools?.result?.tools ?? []).map((t) => t.name);
check("tools/list 包含 deepseek_flash", names.includes("deepseek_flash"), names.join(",") || "无");

const called = await rpc({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: {
    name: "deepseek_flash",
    arguments: { task: "只回复两个字:通了", mode: "analyze" },
  },
});
const content = called?.result?.content?.[0]?.text ?? "";

if (called?.result?.isError === true) {
  console.log(`SKIP  tools/call — DeepSeek 调用未成功(多为 API key 未配置):${content.slice(0, 200)}`);
} else {
  check("tools/call 拿到 DeepSeek 回复", content.length > 0, content.slice(0, 200));
}

console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
shutdown(failures === 0 ? 0 : 1);
