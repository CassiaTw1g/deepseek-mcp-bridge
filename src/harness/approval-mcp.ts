/**
 * The other end of `--permission-prompt-tool`.
 *
 * Claude Code spawns this as a stdio MCP server and calls it every time a tool
 * would need permission. It is not reachable over the network: it exists only
 * as a child of one job's Claude Code process, which is what keeps approval
 * out of reach of whoever holds the capability URL. Sol can dispatch work, but
 * it cannot approve its own commands.
 *
 * Everything it needs arrives through inherited environment:
 *   BRIDGE_JOB_ID, BRIDGE_STATE_DIR, BRIDGE_WORKSPACE,
 *   BRIDGE_APPROVE_ALLOW, BRIDGE_APPROVAL_TIMEOUT_MS
 * — which is why the `--mcp-config` file can be shared by every job.
 *
 * Three kinds of tool call come through here, and each is answered by a
 * different rule. Commands are matched against the pre-approval list, and
 * anything else waits for a person. File tools are checked against the job's
 * workspace — inside is allowed without waking anybody, outside is a person.
 * Network tools always a person. Everything else is Claude Code's own
 * bookkeeping (todo lists, shell output) and is allowed, but recorded once per
 * job so the audit log still shows what ran unattended.
 *
 * NOTE: stdout is the JSON-RPC channel. Never write anything else to it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_ALLOW, autoApprove, awaitDecision, recordAutoApproval, requestApproval } from "../agent/approvals.ts";
import { checkToolPaths } from "./file-guard.ts";

/** Command tools, by platform. */
const COMMAND_TOOLS = new Set(["powershell", "bash"]);

/** Tools whose input names files: checked against the workspace, never waved through blind. */
const FILE_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "notebookread",
  "glob",
  "grep",
  "ls",
]);

/** Tools that carry data *off* this machine. Always a person, never a rule. */
const NETWORK_TOOLS = new Set(["webfetch", "websearch"]);

const jobId = process.env.BRIDGE_JOB_ID ?? "";
const stateDir = process.env.BRIDGE_STATE_DIR ?? "";
const workspace = process.env.BRIDGE_WORKSPACE ?? "";
const timeoutMs = Number(process.env.BRIDGE_APPROVAL_TIMEOUT_MS ?? 5 * 60_000);
const allow = (process.env.BRIDGE_APPROVE_ALLOW ?? DEFAULT_ALLOW.join(","))
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/** Unknown tool names are auto-allowed; one audit line each is enough. */
const seenUnknown = new Set<string>();

const server = new McpServer({ name: "bridge-approval", version: "1.0.0" });

function answer(decision: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(decision) }] };
}

/** One line for `ctl pending`, so the person approves the *thing*, not a label. */
function describe(toolName: string, input: Record<string, unknown>): string {
  const pick = input.command ?? input.file_path ?? input.path ?? input.notebook_path ?? input.url ?? input.query;
  if (typeof pick === "string") return pick.slice(0, 300);
  try {
    return JSON.stringify(input).slice(0, 300);
  } catch {
    return "(无法显示参数)";
  }
}

server.registerTool(
  "approval_prompt",
  {
    title: "批准请求",
    description: "Claude Code 用它询问某次工具调用是否放行。",
    inputSchema: {
      tool_name: z.string().optional(),
      input: z.record(z.string(), z.unknown()).optional(),
    },
  },
  async (args) => {
    const toolName = String(args?.tool_name ?? "");
    const input = (args?.input ?? {}) as Record<string, unknown>;
    const name = toolName.toLowerCase();

    // §1 No job id means this process was started outside a job. Fail closed:
    // an unattributable approval request is exactly the kind that should not be
    // waved through silently. This check now runs *first* — it used to sit
    // below the file-tool branch, which returned "allow" before ever reaching
    // it, so an unattributable file call was the one case that bypassed it.
    if (!jobId || !stateDir) {
      return answer({
        behavior: "deny",
        message:
          "审批服务没有拿到 job 上下文(BRIDGE_JOB_ID / BRIDGE_STATE_DIR 缺失),出于安全默认拒绝。",
      });
    }

    /**
     * Everything that is not an auto-approval ends here: a request file for a
     * human, then a bounded wait. Timeout, cancellation, a corrupt decision and
     * the server dying mid-wait all come back as deny — see `approvals.ts`.
     */
    const askHuman = async (label: string, why: string) => {
      const req = requestApproval(stateDir, {
        jobId,
        toolName,
        command: `${label} —— ${why}`.slice(0, 600),
        cwd: process.cwd(),
        ttlMs: timeoutMs,
      });

      const decision = await awaitDecision(stateDir, req.id, { timeoutMs });

      if (decision.decision !== "allow") {
        return answer({
          behavior: "deny",
          message:
            `${label} 未获批准:${decision.reason ?? "(无说明)"}\n` +
            `原因:${why}\n` +
            "不要改用别的方式绕过它(换个工具、写个脚本、交给子进程都不行);" +
            "把这个情况汇报给调用方,让用户决定。",
        });
      }
      return answer({ behavior: "allow", updatedInput: input });
    };

    // §2 Commands. The base allowlist, then a person. Auto-approvals are still
    // recorded, so the audit log shows what ran unattended, not just what a
    // human waved through.
    if (COMMAND_TOOLS.has(name)) {
      const command = typeof input.command === "string" ? input.command : "";
      const auto = autoApprove(command, allow);
      if (auto.approved) {
        recordAutoApproval(stateDir, { jobId, toolName, command, reason: auto.reason });
        return answer({ behavior: "allow", updatedInput: input });
      }
      return askHuman(`[命令] ${command.slice(0, 200)}`, auto.reason);
    }

    // §3 File tools. Governed by the *workspace*, which `--add-dir` does not
    // enforce: it adds a directory to the allowed set and restricts nothing, so
    // an absolute path anywhere on disk used to be pre-approved. Anything the
    // path check cannot place inside the workspace goes to a person instead —
    // fail closed to a human, not to a silent yes. Reading a file outside the
    // workspace is sometimes legitimate, so the answer is "ask", not "deny".
    if (FILE_TOOLS.has(name)) {
      if (!workspace) {
        return askHuman(
          `[文件工具] ${toolName} ${describe(toolName, input)}`,
          "审批服务没有拿到工作区路径(BRIDGE_WORKSPACE 缺失),无法判断这次访问是否越界。",
        );
      }

      const check = checkToolPaths(toolName, input, workspace);
      if (check.ok) return answer({ behavior: "allow", updatedInput: input });

      return askHuman(
        `[文件工具·越界] ${toolName} ${check.bad.join(" ")}`,
        `路径工作区之外(工作区:${workspace}):${check.reasons.join(";")}`,
      );
    }

    // §4 Network tools. `--add-dir` says nothing about egress, and the file
    // guard above says nothing about it either: this is the one capability that
    // can carry a whole context off the machine in a single call.
    if (NETWORK_TOOLS.has(name)) {
      return askHuman(`[联网] ${toolName} ${describe(toolName, input)}`, "联网工具会把内容发到外部地址,一律需要人工批准。");
    }

    // §5 Anything else is Claude Code's own bookkeeping (TodoWrite, BashOutput,
    // KillShell…): no path, no egress, nothing a rule here could decide better
    // than the tool itself. Allowed, but recorded — once per job per tool name,
    // because a todo list is updated far more often than a human wants to read.
    if (!seenUnknown.has(name)) {
      seenUnknown.add(name);
      recordAutoApproval(stateDir, {
        jobId,
        toolName,
        command: `[其他工具] ${toolName}`,
        reason: "不在命令 / 文件 / 联网名单里,按默认放行(已记录)。",
      });
    }
    return answer({ behavior: "allow", updatedInput: input });
  },
);

await server.connect(new StdioServerTransport());
