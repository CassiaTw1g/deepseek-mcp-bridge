#!/usr/bin/env node
/**
 * Lifecycle manager for the deepseek-bridge plugin.
 *
 * start / stop / restart / status / enable / disable / logs / uninstall
 * secret / rotate / tunnel / untunnel / jobs / pending / approve / deny / audit
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
import { decide, listPending } from "../src/agent/approvals.ts";
import { readJobSnapshots } from "../src/agent/jobs.ts";

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

/** Best effort. Returns whether it worked, so the caller can say so plainly
 *  rather than claiming a copy that did not happen. */
function copyToClipboard(text) {
  try {
    if (isWindows) return spawnSync("clip.exe", [], { input: text }).status === 0;
    const [cmd, args] =
      process.platform === "darwin" ? ["pbcopy", []] : ["xclip", ["-selection", "clipboard"]];
    return spawnSync(cmd, args, { input: text }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Rotate the capability secret: new secret, restart the *server only*, hand the
 * new URL back on the clipboard.
 *
 * `cmdStop()` deliberately kills the tunnel as well — correct for `stop`,
 * wrong here. The tunnel just forwards a port; it has no idea what the path
 * is, so rotating the secret has no reason to cost you a new public hostname
 * and a second trip to the ChatGPT connector. Leaving it up means only the
 * last segment of the URL changes.
 */
function cmdRotate() {
  const state = currentStatus();
  if (state.disabled) {
    console.error("插件处于停用状态。先运行 `npm run enable`。");
    process.exit(1);
  }
  if (!existsSync(ENV_FILE)) {
    console.error(".env 不存在。先复制 .env.example 为 .env 并填写。");
    process.exit(1);
  }

  const secret = randomBytes(32).toString("hex");
  const body = readFileSync(ENV_FILE, "utf8");
  const next = /^MCP_PATH_SECRET=.*$/m.test(body)
    ? body.replace(/^MCP_PATH_SECRET=.*$/m, `MCP_PATH_SECRET=${secret}`)
    : `${body.trimEnd()}\nMCP_PATH_SECRET=${secret}\n`;
  writeFileSync(ENV_FILE, next);
  console.log("[1/3] 已生成新密钥并写入 .env。");

  // Restart only the server. `cmdStart` re-reads .env, so it picks up the new
  // secret on its own — nothing here needs to pass it along.
  const pid = readPid();
  if (pid && isAlive(pid)) {
    if (isWindows) {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    rmSync(PID_FILE, { force: true });
    console.log(`[2/3] 已停止旧服务(PID ${pid}),用新密钥重启…`);
  } else {
    console.log("[2/3] 服务本来就没在跑,直接启动…");
  }
  cmdStart();

  const url = findTunnelUrl();
  if (!readTunnelPid() || !url) {
    console.log("");
    console.log("[3/3] 隧道没在运行,所以还没有公网地址。");
    console.log("      先运行 `npm run tunnel`,再运行 `npm run ctl -- status`。");
    console.log("      本地端点(只能在这台电脑上用):");
    console.log(`        ${describeEndpoint(parseEnvFile()).local}`);
    return;
  }

  const full = `${url}/mcp/${secret}`;
  console.log("");
  console.log("============================================================");
  console.log("  [3/3] 新的公网端点:");
  console.log("");
  console.log(`  ${full}`);
  console.log("============================================================");
  console.log(
    copyToClipboard(full)
      ? "已复制到剪贴板 —— 直接粘进 ChatGPT 的 connector 就行。"
      : "复制失败,请手动选中上面那一行复制。",
  );
  console.log("ChatGPT → Settings → Plugins → MCP → 编辑这个 connector → 换掉 URL。");
}

// --- 任务与审批 -------------------------------------------------------------
//
// The server writes these to disk precisely so this script can read them. When
// you approve a command here you are talking to a *different process* — there is
// no RPC, only the queue directory, which is why approving works even if the
// server was restarted between the request and your answer.

function shortTask(task) {
  return task.length > 60 ? `${task.slice(0, 60)}…` : task;
}

function cmdPending() {
  const items = listPending(STATE_DIR);
  if (items.length === 0) {
    console.log("没有待批准的命令。");
    return;
  }
  console.log(`有 ${items.length} 条命令在等你的批准:\n`);
  for (const item of items) {
    const waited = Math.round((Date.now() - item.createdAt) / 1000);
    console.log(`  ${item.id}   (任务 ${item.jobId},已等 ${waited} 秒)`);
    console.log(`    要执行的命令 : ${item.command}`);
    console.log(`    工作目录     : ${item.cwd}`);
    console.log(`    批准 : npm run ctl -- approve ${item.id}`);
    console.log(`    拒绝 : npm run ctl -- deny ${item.id}`);
    console.log("");
  }
  console.log("看不懂这条命令会做什么,就拒绝。批准的单位是这一整条命令。");
}

function cmdDecide(id, decision) {
  if (!id) {
    console.error(`用法:npm run ctl -- ${decision} <id>`);
    process.exit(1);
  }
  const result = decide(STATE_DIR, id, decision);
  console.log(result.message);
  if (!result.ok) process.exit(1);
}

function formatDuration(job) {
  const end = job.finishedAt ?? Date.now();
  const seconds = Math.round((end - job.startedAt) / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}分${seconds % 60}秒` : `${seconds}秒`;
}

function cmdJobs(id, { trace = false } = {}) {
  const jobs = readJobSnapshots(STATE_DIR);
  if (jobs.length === 0) {
    console.log("还没有任务记录。");
    return;
  }

  if (id) {
    const job = jobs.find((j) => j.id === id);
    if (!job) {
      console.error(`找不到任务 ${id}。`);
      process.exit(1);
    }
    console.log(`任务     : ${job.id}`);
    console.log(`状态     : ${job.state}`);
    console.log(`工作区   : ${job.workspace}`);
    console.log(`步数     : ${job.steps}`);
    console.log(`耗时     : ${formatDuration(job)}`);
    console.log(`验证码   : ${job.nonce}`);
    console.log(`任务内容 : ${job.task}`);
    if (job.error) console.log(`错误     : ${job.error}`);
    if (job.result?.text) {
      console.log("");
      console.log("结果:");
      console.log(job.result.text);
    }
    if (trace) {
      console.log("");
      console.log("轨迹:");
      for (const e of job.events) {
        const time = new Date(e.at).toISOString().slice(11, 19);
        const name = e.name ? ` ${e.name}` : "";
        console.log(`  [${time}] #${e.step} ${e.type}${name} ${e.detail ?? ""}`);
      }
      if (job.events.length === 0) console.log("  (无事件)");
    }
    return;
  }

  console.log(`${jobs.length} 个任务(最近的在前):\n`);
  for (const job of jobs) {
    console.log(`  ${job.id}  ${job.state.padEnd(17)} ${String(job.steps).padStart(3)} 步  ${formatDuration(job).padStart(8)}  ${job.nonce}`);
    console.log(`      ${shortTask(job.task)}`);
  }
  console.log("\n看某一个任务的完整轨迹:npm run ctl -- jobs <id> --trace");
}

function cmdJobKill(id) {
  if (!id) {
    console.error("用法:npm run ctl -- job kill <id>");
    process.exit(1);
  }
  ensureStateDir();
  const dir = join(STATE_DIR, "cancel");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ at: Date.now() }));
  console.log(`已请求取消任务 ${id}。`);
  console.log("任务进程会在 1 秒内被结束(连同它启动的所有子进程)。");
}

function cmdAudit(lines) {
  const file = join(STATE_DIR, "audit.log");
  if (!existsSync(file)) {
    console.log("还没有审计记录。");
    return;
  }
  const rows = readFileSync(file, "utf8").trim().split(/\r?\n/);
  const tail = rows.slice(-(lines || 30));
  for (const row of tail) {
    try {
      const e = JSON.parse(row);
      const time = new Date(e.at).toISOString().slice(11, 19);
      if (e.type === "approval_auto") {
        console.log(`[${time}] 自动放行  ${e.command}`);
      } else if (e.type === "approval_requested") {
        console.log(`[${time}] 请求批准  ${e.id}  ${e.command}`);
      } else if (e.type === "approval_decided") {
        console.log(`[${time}] ${e.decision === "allow" ? "已批准  " : "已拒绝  "} ${e.id}  ${e.reason ?? ""}`);
      } else if (e.type === "approval_timeout") {
        console.log(`[${time}] 超时拒绝  ${e.id}`);
      } else {
        console.log(`[${time}] ${e.type}  ${JSON.stringify(e).slice(0, 160)}`);
      }
    } catch {
      console.log(row);
    }
  }
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
const positional = rest.filter((a) => !a.startsWith("-"));

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
  case "rotate":
    cmdRotate();
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
  case "jobs":
    cmdJobs(positional[0], { trace: flags.has("--trace") });
    break;
  case "job":
    if (positional[0] === "kill") cmdJobKill(positional[1]);
    else {
      console.error("用法:npm run ctl -- job kill <id>");
      process.exit(1);
    }
    break;
  case "pending":
    cmdPending();
    break;
  case "approve":
    cmdDecide(positional[0], "allow");
    break;
  case "deny":
    cmdDecide(positional[0], "deny");
    break;
  case "audit":
    cmdAudit(flags.has("--all") ? 500 : 30);
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

子代理任务:

  jobs                     列出所有任务:状态 / 步数 / 耗时 / 验证码
  jobs <id> --trace        看某个任务的完整轨迹(第几步调了什么工具)
  job kill <id>            取消一个正在跑的任务(连同它的子进程)
  pending                  列出正在等你批准的命令
  approve <id>             批准一条命令,任务继续
  deny <id>                拒绝一条命令,任务会收到拒绝原因
  audit                    看最近的审批记录(--all 看全部)
`);
    process.exit(command ? 1 : 0);
}
