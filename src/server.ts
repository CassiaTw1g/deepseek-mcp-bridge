import "dotenv/config";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp.ts";
import { createRegistry } from "./agent/jobs.ts";
import { createClaudeCodeRunner } from "./harness/claude-code.ts";
import { createPolicy, parseRoots } from "./sandbox.ts";

const PORT = Number(process.env.PORT ?? 8787);
// Loopback only. The tunnel runs on this machine, so nothing outside it has any
// business reaching the port — binding 0.0.0.0 would put the endpoint on the LAN.
const HOST = process.env.HOST ?? "127.0.0.1";
const PATH_SECRET = process.env.MCP_PATH_SECRET ?? "";
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 20);
const RATE_LIMIT_WINDOW_MS = 60_000;

if (PATH_SECRET.length < 16) {
  console.error(
    "MCP_PATH_SECRET 未设置或过短(至少 16 字符)。\n" +
      "生成方式:`npm run ctl -- secret`,写进 .env。详见 README。",
  );
  process.exit(1);
}

const MCP_PATH = `/mcp/${PATH_SECRET}`;

const hits = new Map<string, number[]>();

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);

  if (hits.size > 1000) {
    for (const [k, v] of hits) {
      if (!v.some((t) => now - t < RATE_LIMIT_WINDOW_MS)) hits.delete(k);
    }
  }
  return recent.length > RATE_LIMIT_MAX;
}

// ---------------------------------------------------------------------------
// Agent jobs
// ---------------------------------------------------------------------------

// Fail closed: with no roots configured, every workspace is denied. An agent
// tool that silently defaults to "anywhere on disk" is worse than one that
// refuses to run until someone names the directories they meant.
const allowedRoots = parseRoots(process.env.DEEPSEEK_ALLOWED_ROOTS);
const policy = createPolicy(allowedRoots);

if (allowedRoots.length === 0) {
  console.warn(
    "DEEPSEEK_ALLOWED_ROOTS 未设置 —— agent 工具会拒绝所有工作区。\n" +
      "要启用,请在 .env 里列出允许子代理操作的根目录(多个用 ; 分隔)并重启。",
  );
} else {
  console.log(`允许的工作区根目录:${allowedRoots.join(", ")}`);
}

/**
 * One registry for the whole process — deliberately created out here, not
 * inside the request handler. `createMcpServer()` runs once per request in
 * stateless mode, so a registry built there would forget every job the instant
 * its `start` call returned.
 */
const registry = createRegistry(
  createClaudeCodeRunner({
    maxSteps: Number(process.env.BRIDGE_MAX_STEPS ?? 40),
    timeoutMs: Number(process.env.BRIDGE_JOB_TIMEOUT_MS ?? 15 * 60_000),
  }),
  { harnessName: "claude-code" },
);

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post(MCP_PATH, async (req, res) => {
  if (isRateLimited(req.ip ?? "unknown")) {
    console.log(`[${new Date().toISOString()}] RATE LIMITED ${req.ip}`);
    res.status(429).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Rate limit exceeded. Try again shortly." },
      id: null,
    });
    return;
  }

  // One line per request. This is how you tell "ChatGPT actually called us"
  // apart from "Sol pretended to call us", which looks identical in the chat.
  const method = req.body?.method ?? "?";
  const toolName = req.body?.params?.name;
  console.log(`[${new Date().toISOString()}] ${method}${toolName ? ` ${toolName}` : ""}`);

  // Stateless: a fresh server+transport per request. Sharing them across
  // requests leaks state between callers. The registry is passed in precisely
  // because it must NOT be per-request.
  const server = createMcpServer(registry, policy);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  // Closing the transport aborts the SDK's per-request handler signal, which
  // the client triggers simply by hanging up — routine when a 45-second
  // synchronous window exceeds ChatGPT's own tool timeout. That signal is used
  // only to stop waiting; it is never wired to a job's controller, or every
  // impatient caller would kill its own job.
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error." },
        id: null,
      });
    }
  }
});

// Stateless mode has no session to stream or terminate.
const methodNotAllowed = (req: express.Request, res: express.Response) => {
  void req;
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
};
app.get(MCP_PATH, methodNotAllowed);
app.delete(MCP_PATH, methodNotAllowed);

// Anything else under /mcp: the capability path is the credential, so a wrong
// path must be indistinguishable from nothing being here.
app.use("/mcp", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`deepseek-bridge listening on http://${HOST}:${PORT}`);
  console.log(`MCP endpoint path: ${MCP_PATH}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`Received ${signal}, shutting down.`);
    // Abort in-flight jobs first: each one owns a spawned Claude Code process
    // and possibly a tree of grandchildren under it.
    registry.shutdown();
    httpServer.close(() => process.exit(0));
  });
}
