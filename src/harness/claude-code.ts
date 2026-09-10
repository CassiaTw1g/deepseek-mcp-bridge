import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { STATE_DIR, type JobContext, type JobInput, type JobResult, type JobRunner } from "../agent/jobs.ts";
import { DEFAULT_ALLOW, listPending } from "../agent/approvals.ts";

/**
 * Runs a task by spawning Claude Code in headless mode, pointed at DeepSeek.
 *
 * Claude Code is the harness — it owns the loop, the tools, context compaction
 * and prompt caching. This module only starts it, watches it, and reports what
 * it did. None of the file/shell safety logic lives here; Claude Code's own
 * permission system is the control, which is why the allowlist below matters.
 */

/**
 * `PowerShell` is the command tool on Windows, `Bash` elsewhere. Naming both is
 * deliberate: a probe run that listed only `Bash` had every single command
 * denied, and the model burned four attempts discovering that. Listing a tool
 * that does not exist on this platform is harmless.
 */
const DEFAULT_ALLOWED = "Read Write Edit Glob Grep Bash PowerShell";

/**
 * The same list minus the command tools. Approval and pre-approval are not
 * compatible for the *same* tool, and — measured — `--allowedTools` does not
 * restrict anything anyway: passing only "Read" still let PowerShell run. Its
 * only real effect is pre-approval, which is exactly what must not happen to
 * the command tool once a human is supposed to be in the loop.
 */
const APPROVAL_ALLOWED = "Read Write Edit Glob Grep";

/** Namespace Claude Code assigns to an MCP server called `bridge`. */
const APPROVAL_TOOL = "mcp__bridge__approval_prompt";

export interface ClaudeCodeOptions {
  bin?: string;
  allowedTools?: string;
  permissionMode?: string;
  /** MCP tool that answers permission prompts — see `--permission-prompt-tool`. */
  permissionPromptTool?: string;
  /** Route unlisted commands to the human approval queue. Default on. */
  approval?: boolean;
  approvalAllow?: string[];
  approvalTimeoutMs?: number;
  /** Hard stop after this many tool calls, enforced by killing the child. */
  maxSteps?: number;
  timeoutMs?: number;
  /** Isolated config dir; keeps the child off the operator's personal account. */
  configDir?: string;
  stateDir?: string;
}

function resolveBin(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.BRIDGE_CLAUDE_BIN) return process.env.BRIDGE_CLAUDE_BIN;

  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const candidates = [join(home, ".local", "bin", exe), join(home, ".claude", "local", exe)];
  for (const c of candidates) if (home && existsSync(c)) return c;
  return exe;
}

/**
 * Point the child at DeepSeek and nowhere else.
 *
 * Two things are being prevented here. First, billing: the bridge must spend
 * its own dedicated DeepSeek key, never the operator's Anthropic account.
 * Second, inheritance — the operator's own `ANTHROPIC_*` variables, and their
 * `~/.claude/settings.json`, would otherwise silently redirect a job onto their
 * personal subscription.
 */
/**
 * Claude Code reads plugins, MCP servers and permission rules from
 * CLAUDE_CONFIG_DIR. These two files go in the bridge's own state directory
 * instead — `--settings` and `--mcp-config` take explicit paths — because
 * CLAUDE_CONFIG_DIR can be pointed at the operator's real `~/.claude` through
 * BRIDGE_CLAUDE_CONFIG_DIR, and overwriting their settings.json would be a
 * genuinely destructive bug.
 */
function prepareApprovalFiles(stateDir: string): { settings: string; mcp: string } {
  const dir = join(stateDir, "cc");
  mkdirSync(dir, { recursive: true });

  const settings = join(dir, "settings.json");
  // `ask` is the only lever that makes `--permission-prompt-tool` fire at all.
  // Without it, headless mode runs the command tool silently and no permission
  // question is ever asked — measured, not assumed.
  writeFileSync(settings, JSON.stringify({ permissions: { ask: ["PowerShell", "Bash"] } }, null, 2), "utf8");

  const mcp = join(dir, "mcp.json");
  const entry = join(dirname(fileURLToPath(import.meta.url)), "approval-mcp.ts");
  // process.execPath, not "node": that is the interpreter already running the
  // bridge, so the child cannot pick up a different one from PATH.
  writeFileSync(
    mcp,
    JSON.stringify({ mcpServers: { bridge: { command: process.execPath, args: [entry] } } }, null, 2),
    "utf8",
  );

  return { settings, mcp };
}

function buildEnv(configDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const key = process.env.DEEPSEEK_API_KEY;

  if (key) {
    const base = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "");
    env.ANTHROPIC_AUTH_TOKEN = key;
    env.ANTHROPIC_BASE_URL = process.env.BRIDGE_ANTHROPIC_BASE_URL ?? `${base}/anthropic`;
    env.ANTHROPIC_MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-flash";
  }

  delete env.ANTHROPIC_API_KEY;
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

/**
 * `child.kill()` does not reap grandchildren on Windows, and a shell tool
 * routinely spawns them (`node x.mjs` starts a child of the shell). `taskkill
 * /T` walks the tree. Same approach `scripts/ctl.mjs` uses for the server.
 */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch {
      /* best effort */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* best effort */
  }
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const pick = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.prompt ?? o.url;
  if (typeof pick === "string") return pick.slice(0, 300);
  try {
    return JSON.stringify(input).slice(0, 300);
  } catch {
    return "";
  }
}

interface ResultLine {
  type: "result";
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  permission_denials?: { tool_name?: string; tool_input?: unknown }[];
}

export function createClaudeCodeRunner(options: ClaudeCodeOptions = {}): JobRunner {
  return (input, ctx) => runClaudeCode(input, ctx, options);
}

export async function runClaudeCode(
  input: JobInput,
  ctx: JobContext,
  options: ClaudeCodeOptions = {},
): Promise<JobResult> {
  const workspace = input.workspace;
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new Error(`工作区不存在或不是目录:${workspace}`);
  }

  const bin = resolveBin(options.bin);
  const maxSteps = options.maxSteps ?? 40;
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;

  const stateDir = options.stateDir ?? STATE_DIR;
  const approvalOn = options.approval ?? process.env.BRIDGE_CC_APPROVAL !== "off";
  const approvalAllow = options.approvalAllow ?? DEFAULT_ALLOW;
  const approvalTimeoutMs =
    options.approvalTimeoutMs ?? Number(process.env.BRIDGE_APPROVAL_TIMEOUT_MS ?? 5 * 60_000);

  // Bridge-scoped, not job-scoped: config isolation is about keeping the child
  // off the operator's account, and putting it in the workspace would litter
  // every job's output directory with a config tree.
  const configDir = options.configDir ?? join(tmpdir(), "deepseek-bridge-claude-config");
  const env = buildEnv(configDir);

  const args = [
    "-p",
    input.task,
    "--output-format",
    "stream-json",
    // Required by this CLI version whenever --print and stream-json are combined.
    "--verbose",
    "--add-dir",
    workspace,
    "--permission-mode",
    options.permissionMode ?? "acceptEdits",
  ];

  if (approvalOn) {
    const files = prepareApprovalFiles(stateDir);
    args.push(
      "--settings",
      files.settings,
      "--mcp-config",
      files.mcp,
      "--permission-prompt-tool",
      options.permissionPromptTool ?? APPROVAL_TOOL,
      "--allowedTools",
      options.allowedTools ?? APPROVAL_ALLOWED,
    );
    // The approval MCP server reads these from its own environment, which it
    // inherits through the Claude Code child. That is what lets a single shared
    // mcp.json serve every job instead of one file per job.
    env.BRIDGE_JOB_ID = ctx.jobId;
    env.BRIDGE_STATE_DIR = stateDir;
    env.BRIDGE_APPROVE_ALLOW = approvalAllow.join(",");
    env.BRIDGE_APPROVAL_TIMEOUT_MS = String(approvalTimeoutMs);
  } else {
    args.push("--allowedTools", options.allowedTools ?? DEFAULT_ALLOWED);
    if (options.permissionPromptTool) args.push("--permission-prompt-tool", options.permissionPromptTool);
  }
  // Deliberately opt-in: Claude Code prices against Claude rates, so a budget
  // set here reads as ~100x the real DeepSeek cost and would cut jobs off early.
  const budget = process.env.BRIDGE_CC_MAX_BUDGET_USD;
  if (budget) args.push("--max-budget-usd", budget);

  const child = spawn(bin, args, {
    cwd: workspace,
    env,
    windowsHide: true, // otherwise a console window flashes on the operator's desktop
    // stdin must be ignored, not left open: with --print the CLI waits ~3s for
    // input before proceeding, on every single job.
    stdio: ["ignore", "pipe", "pipe"],
  });

  let toolCalls = 0;
  let final: ResultLine | undefined;
  let stderr = "";
  let killedFor: string | undefined;

  const stop = (reason: string) => {
    if (killedFor) return;
    killedFor = reason;
    if (child.pid) killTree(child.pid);
  };

  const onAbort = () => stop("任务被取消。");
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop(`任务超过 ${Math.round(timeoutMs / 60_000)} 分钟上限,已中止。`), timeoutMs);
  timer.unref();

  // Two cross-process signals arrive by file, not in the child's output, so
  // both have to be polled: "a human is being asked" (approval queue), and
  // "stop" (`npm run ctl -- job kill`, which is a different process and cannot
  // reach this job's AbortController any other way). Neither is visible in the
  // stream — a job waiting on approval looks exactly like a job that went quiet.
  let pendingSeen = -1;
  const watch = setInterval(() => {
    if (ctx.checkCancelled()) {
      stop("任务被取消。");
      return;
    }
    if (!approvalOn) return;

    const pending = listPending(stateDir).filter((p) => p.jobId === ctx.jobId);
    if (pending.length === pendingSeen) return;
    pendingSeen = pending.length;
    ctx.setWaitingApproval(pending.length > 0);
    if (pending.length > 0) {
      ctx.record({
        step: toolCalls,
        type: "note",
        detail: `等待批准:${pending[0].command.slice(0, 200)}`,
      });
    }
  }, 500);
  watch.unref();

  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8");
    });
  }

  if (child.stdout) {
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // The CLI prints non-JSON warnings (e.g. unrecognized_model) on stdout.
        return;
      }

      if (obj.type === "assistant") {
        const blocks = (obj.message as { content?: unknown[] } | undefined)?.content;
        if (!Array.isArray(blocks)) return;
        for (const block of blocks) {
          const b = block as { type?: string; name?: string; input?: unknown; text?: string };
          if (b?.type === "tool_use") {
            toolCalls++;
            ctx.setSteps(toolCalls);
            ctx.record({
              step: toolCalls,
              type: "tool",
              name: String(b.name ?? "?"),
              detail: summarizeInput(b.input),
            });
            if (toolCalls > maxSteps) stop(`任务超过 ${maxSteps} 步上限,已中止。`);
          } else if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
            ctx.record({ step: toolCalls, type: "note", detail: b.text.slice(0, 300) });
          }
        }
        return;
      }

      if (obj.type === "result") final = obj as unknown as ResultLine;
    });
  }

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  }).finally(() => {
    ctx.signal.removeEventListener("abort", onAbort);
    clearTimeout(timer);
    clearInterval(watch);
  });

  const usage = final?.usage;
  const usageOut = usage
    ? {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      }
    : undefined;

  if (usage?.cache_read_input_tokens) {
    ctx.record({ step: toolCalls, type: "note", detail: `缓存命中 ${usage.cache_read_input_tokens} 输入 token` });
  }

  if (killedFor) throw new Error(killedFor);

  if (!final) {
    const tail = stderr.trim().slice(0, 400);
    throw new Error(
      `Claude Code 没有返回结果(退出码 ${exitCode})。${tail ? `stderr: ${tail}` : "无 stderr 输出。"}`,
    );
  }

  const denials = Array.isArray(final.permission_denials) ? final.permission_denials : [];
  for (const d of denials) {
    ctx.record({
      step: toolCalls,
      type: "error",
      name: String(d.tool_name ?? "?"),
      detail: `权限被拒: ${summarizeInput(d.tool_input)}`,
    });
  }

  const text = typeof final.result === "string" ? final.result : "";
  if (final.is_error) {
    throw new Error(`Claude Code 报告任务失败:${text.slice(0, 300) || "(无说明)"}`);
  }
  if (!text.trim()) {
    throw new Error("Claude Code 结束但没有产出内容。");
  }

  return {
    // Surface denials to the caller: a run that "succeeded" after being blocked
    // from the tools it needed is a different thing from one that really did
    // the work, and the calling model should not have to guess which it got.
    text: denials.length ? `${text}\n\n[注意:有 ${denials.length} 次工具调用被权限拒绝,结果可能不完整。]` : text,
    steps: toolCalls,
    usage: usageOut,
  };
}
