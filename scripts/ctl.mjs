#!/usr/bin/env node
/**
 * Lifecycle manager for the deepseek-bridge plugin.
 *
 * start / stop / restart / status / enable / disable / logs / uninstall / secret
 *
 * The server is spawned detached so it survives this shell exiting.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "src", "server.ts");
const ENV_FILE = join(ROOT, ".env");
const STATE_DIR = join(ROOT, ".state");
const PID_FILE = join(STATE_DIR, "server.pid");
const LOG_FILE = join(STATE_DIR, "server.log");
const DISABLED_FLAG = join(STATE_DIR, "disabled");
const TUNNEL_PID_FILE = join(STATE_DIR, "tunnel.pid");
const TUNNEL_LOG_FILE = join(STATE_DIR, "tunnel.log");

const isWindows = process.platform === "win32";

function parseEnvFile() {
  if (!existsSync(ENV_FILE)) return {};
  const out = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true });
}

function readPid(file = PID_FILE) {
  if (!existsSync(file)) return null;
  const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** cloudflared via PATH, else the usual install locations winget/brew use. */
function resolveCloudflared() {
  const candidates = [
    join(process.env["ProgramFiles(x86)"] ?? "", "cloudflared", "cloudflared.exe"),
    join(process.env.ProgramFiles ?? "", "cloudflared", "cloudflared.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links", "cloudflared.exe"),
    "/usr/local/bin/cloudflared",
    "/opt/homebrew/bin/cloudflared",
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "cloudflared";
}

/** Only the current run's section — the log is appended across restarts, and an
 *  earlier run's URL would otherwise still match. */
function currentTunnelLog() {
  if (!existsSync(TUNNEL_LOG_FILE)) return "";
  const body = readFileSync(TUNNEL_LOG_FILE, "utf8");
  const marker = body.lastIndexOf("--- tunnel ");
  return marker >= 0 ? body.slice(marker) : body;
}

function findTunnelUrl() {
  const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(currentTunnelLog());
  return m ? m[0] : null;
}

async function waitForTunnelUrl(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = findTunnelUrl();
    if (url) return url;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function currentStatus() {
  const pid = readPid();
  const alive = isAlive(pid);
  if (!alive && existsSync(PID_FILE)) rmSync(PID_FILE, { force: true });
  return {
    disabled: existsSync(DISABLED_FLAG),
    running: alive,
    pid: alive ? pid : null,
    env: parseEnvFile(),
  };
}

function describeEndpoint(env) {
  const port = env.PORT ?? "8787";
  const secret = env.MCP_PATH_SECRET ?? "";
  return {
    local: `http://127.0.0.1:${port}/mcp/${secret}`,
    pathOnly: `/mcp/${secret}`,
  };
}

function preflight() {
  const env = parseEnvFile();
  const problems = [];
  if (!existsSync(ENV_FILE)) {
    problems.push(".env 不存在。复制 .env.example 为 .env 并填写。");
  }
  if (!env.DEEPSEEK_API_KEY || !env.DEEPSEEK_API_KEY.startsWith("sk-")) {
    problems.push("DEEPSEEK_API_KEY 未设置或格式不对(应以 sk- 开头)。");
  }
  if (!env.MCP_PATH_SECRET || env.MCP_PATH_SECRET.length < 16) {
    problems.push("MCP_PATH_SECRET 未设置或过短。运行 `npm run ctl -- secret` 生成一个。");
  }
  return problems;
}

function cmdStart({ foreground = false } = {}) {
  const state = currentStatus();

  if (state.disabled) {
    console.error("插件处于停用状态。先运行 `npm run enable`。");
    process.exit(1);
  }
  if (state.running) {
    console.log(`已在运行,PID ${state.pid}。`);
    return;
  }

  const problems = preflight();
  if (problems.length > 0) {
    console.error("启动前检查未通过:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  ensureStateDir();
  const env = { ...process.env, ...parseEnvFile() };

  if (foreground) {
    const child = spawn(process.execPath, [ENTRY], { cwd: ROOT, env, stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

  const logFd = openSync(LOG_FILE, "a");
  appendFileSync(LOG_FILE, `\n--- start ${new Date().toISOString()} ---\n`);

  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
  });

  child.unref();
  writeFileSync(PID_FILE, String(child.pid));

  const { local, pathOnly } = describeEndpoint(env);
  console.log(`已启动,PID ${child.pid}`);
  console.log(`  本地端点 : ${local}`);
  console.log(`  MCP 路径 : ${pathOnly}`);
  console.log(`  日志     : ${LOG_FILE}`);
}

function cmdStop() {
  const pid = readPid();
  if (!pid || !isAlive(pid)) {
    if (existsSync(PID_FILE)) rmSync(PID_FILE, { force: true });
    console.log("未在运行。");
    return;
  }

  if (isWindows) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }

  rmSync(PID_FILE, { force: true });
  console.log(`已停止,PID ${pid}。`);
  cmdUntunnel();
}

function readTunnelPid() {
  const pid = readPid(TUNNEL_PID_FILE);
  if (!pid) {
    if (existsSync(TUNNEL_PID_FILE)) rmSync(TUNNEL_PID_FILE, { force: true });
    return null;
  }
  if (!isAlive(pid)) {
    rmSync(TUNNEL_PID_FILE, { force: true });
    return null;
  }
  return pid;
}

function cmdUntunnel() {
  const pid = readTunnelPid();
  if (!pid) {
    console.log("隧道未在运行。");
    return;
  }
  if (isWindows) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  rmSync(TUNNEL_PID_FILE, { force: true });
  console.log(`隧道已停止,PID ${pid}。`);
}

async function cmdTunnel() {
  const state = currentStatus();
  if (state.disabled) {
    console.error("插件处于停用状态。先运行 `npm run enable`。");
    process.exit(1);
  }
  if (!state.running) {
    console.error("服务未运行。先运行 `npm start`。");
    process.exit(1);
  }

  const existing = readTunnelPid();
  if (existing) {
    const url = findTunnelUrl();
    console.log(`隧道已在运行,PID ${existing}`);
    if (url) console.log(`公网端点 : ${url}/mcp/${state.env.MCP_PATH_SECRET ?? ""}`);
    return;
  }

  const env = { ...process.env, ...state.env };
  const port = env.PORT ?? "8787";
  ensureStateDir();
  appendFileSync(TUNNEL_LOG_FILE, `\n--- tunnel ${new Date().toISOString()} ---\n`);

  const logFd = openSync(TUNNEL_LOG_FILE, "a");
  // --protocol http2 is not optional: QUIC is unreliable on many CN networks,
  // and without it the tunnel registers but never carries traffic.
  const child = spawn(
    resolveCloudflared(),
    ["tunnel", "--url", `http://localhost:${port}`, "--protocol", "http2"],
    { cwd: ROOT, env, detached: true, windowsHide: true, stdio: ["ignore", logFd, logFd] },
  );
  child.unref();
  writeFileSync(TUNNEL_PID_FILE, String(child.pid));

  console.log(`隧道启动中(PID ${child.pid}),等待分配公网地址…`);
  const url = await waitForTunnelUrl(30_000);
  if (!url) {
    console.error(`30 秒内没拿到公网地址。看日志:${TUNNEL_LOG_FILE}`);
    process.exit(1);
  }

  const full = `${url}/mcp/${env.MCP_PATH_SECRET ?? ""}`;
  console.log("");
  console.log(`公网端点 : ${full}`);
  console.log(`健康检查 : ${url}/health`);
  console.log("");
  console.log("填进 ChatGPT 网页版 → Settings → Plugins → MCP → Add server:");
  console.log("  类型选 Streamable HTTP,鉴权选「无鉴权 / No authentication」");
  console.log(`  URL  ${full}`);
}

function cmdStatus() {
  const state = currentStatus();
  const { local } = describeEndpoint(state.env);
  const tunnelPid = readTunnelPid();
  const tunnelUrl = findTunnelUrl();
  console.log(`状态     : ${state.disabled ? "已停用 (disabled)" : "已启用 (enabled)"}`);
  console.log(`进程     : ${state.running ? `运行中,PID ${state.pid}` : "未运行"}`);
  console.log(`本地端点 : ${local}`);
  if (tunnelPid) {
    console.log(`隧道     : 运行中,PID ${tunnelPid}`);
    console.log(
      `公网端点 : ${tunnelUrl ? `${tunnelUrl}/mcp/${state.env.MCP_PATH_SECRET ?? ""}` : "(地址未知,看 tunnel.log)"}`,
    );
  } else {
    console.log(`隧道     : 未运行(要接 ChatGPT 就运行 \`npm run tunnel\`)`);
  }
  console.log(`日志     : ${LOG_FILE}`);
  if (!existsSync(ENV_FILE)) console.log("注意     : .env 不存在,尚未配置。");
}

function cmdEnable() {
  ensureStateDir();
  rmSync(DISABLED_FLAG, { force: true });
  console.log("已启用。");
}

function cmdDisable() {
  ensureStateDir();
  cmdStop();
  writeFileSync(DISABLED_FLAG, new Date().toISOString());
  console.log("已停用。运行 `npm run enable` 可恢复。");
}

function cmdLogs() {
  if (!existsSync(LOG_FILE)) {
    console.log("还没有日志。");
    return;
  }
  const lines = readFileSync(LOG_FILE, "utf8").split(/\r?\n/);
  console.log(lines.slice(-40).join("\n"));
}

function cmdSecret() {
  const secret = randomBytes(32).toString("hex");
  ensureStateDir();
  if (existsSync(ENV_FILE)) {
    const body = readFileSync(ENV_FILE, "utf8");
    const next = /^MCP_PATH_SECRET=.*$/m.test(body)
      ? body.replace(/^MCP_PATH_SECRET=.*$/m, `MCP_PATH_SECRET=${secret}`)
      : `${body.trimEnd()}\nMCP_PATH_SECRET=${secret}\n`;
    writeFileSync(ENV_FILE, next);
    console.log(`已写入 .env:MCP_PATH_SECRET=${secret}`);
  } else {
    console.log(secret);
  }
  console.log("注意:改动后需要重新启动服务,并同步更新 ChatGPT connector 里的 URL。");
}

function cmdUninstall({ purge = false } = {}) {
  cmdStop();
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true });
  console.log("本地状态已清除。");
  console.log("");
  console.log("还需要手动做一步(这个脚本碰不到 ChatGPT):");
  console.log("  打开 ChatGPT 网页版 → Settings → Plugins → MCP → 删除 deepseek-bridge 这个 server。");
  if (purge) {
    console.log("");
    console.log("--purge 已指定,但为安全起见不自动删除项目目录。");
    console.log(`请手动删除:${ROOT}`);
  }
}

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest);

switch (command) {
  case "start":
    cmdStart({ foreground: flags.has("--foreground") || flags.has("-f") });
    break;
  case "stop":
    cmdStop();
    break;
  case "restart":
    cmdStop();
    cmdStart();
    break;
  case "status":
    cmdStatus();
    break;
  case "enable":
    cmdEnable();
    break;
  case "disable":
    cmdDisable();
    break;
  case "logs":
    cmdLogs();
    break;
  case "secret":
    cmdSecret();
    break;
  case "tunnel":
    await cmdTunnel();
    break;
  case "untunnel":
    cmdUntunnel();
    break;
  case "uninstall":
    cmdUninstall({ purge: flags.has("--purge") });
    break;
  default:
    console.log(`deepseek-bridge 生命周期管理

用法: npm run <命令>

  start        后台启动服务(已运行时无操作)
  start --foreground   前台启动,便于调试
  stop         停止服务和隧道
  restart      重启服务(隧道若在跑会一起停掉,需重新 tunnel)
  status       查看启用状态、进程、本地与公网端点
  logs         查看最近 40 行日志
  tunnel       启动 Cloudflare 隧道,打印可填进 ChatGPT 的公网 URL
  untunnel     只停隧道,服务继续跑
  enable       解除停用
  disable      停用并停止服务
  secret       生成并写入 MCP_PATH_SECRET(会同步更新 .env)
  uninstall    停止服务并清除本地状态(并提示如何移除 ChatGPT connector)
`);
    process.exit(command ? 1 : 0);
}
