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
 *   BRIDGE_JOB_ID, BRIDGE_STATE_DIR, BRIDGE_APPROVE_ALLOW, BRIDGE_APPROVAL_TIMEOUT_MS
 * — which is why the `--mcp-config` file can be shared by every job.
 *
 * NOTE: stdout is the JSON-RPC channel. Never write anything else to it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_ALLOW, autoApprove, awaitDecision, recordAutoApproval, requestApproval } from "../agent/approvals.ts";

/** Command tools, by platform. Anything not here is a file tool and is allowed. */
const COMMAND_TOOLS = new Set(["powershell", "bash"]);

const jobId = process.env.BRIDGE_JOB_ID ?? "";
const stateDir = process.env.BRIDGE_STATE_DIR ?? "";
const timeoutMs = Number(process.env.BRIDGE_APPROVAL_TIMEOUT_MS ?? 5 * 60_000);
const allow = (process.env.BRIDGE_APPROVE_ALLOW ?? DEFAULT_ALLOW.join(","))
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const server = new McpServer({ name: "bridge-approval", version: "1.0.0" });

function answer(decision: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(decision) }] };
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

    // §1 File tools are governed by --add-dir, not by this queue. Asking here
    // would mean a human approves every single edit, which is not a control
    // anybody would keep switched on.
    if (!COMMAND_TOOLS.has(toolName.toLowerCase())) {
      return answer({ behavior: "allow", updatedInput: input });
    }

    const command = typeof input.command === "string" ? input.command : "";

    // §2 No job id means this process was started outside a job. Fail closed:
    // an unattributable approval request is exactly the kind that should not be
    // waved through silently.
    if (!jobId || !stateDir) {
      return answer({
        behavior: "deny",
        message:
          "审批服务没有拿到 job 上下文(BRIDGE_JOB_ID / BRIDGE_STATE_DIR 缺失),出于安全默认拒绝。",
      });
    }

    // §3 The base allowlist. Auto-approvals are still recorded, so the audit
    // log shows what ran unattended, not just what a human waved through.
    const auto = autoApprove(command, allow);
    if (auto.approved) {
      recordAutoApproval(stateDir, { jobId, toolName, command, reason: auto.reason });
      return answer({ behavior: "allow", updatedInput: input });
    }

    // §4 Everything else waits for a person.
    const req = requestApproval(stateDir, {
      jobId,
      toolName,
      command,
      cwd: process.cwd(),
      ttlMs: timeoutMs,
    });

    const decision = await awaitDecision(stateDir, req.id, { timeoutMs });

    if (decision.decision !== "allow") {
      return answer({
        behavior: "deny",
        message:
          `命令未获批准:${decision.reason ?? "(无说明)"}\n` +
          "不要改用别的方式绕过它;把这个情况汇报给调用方,让用户决定。",
      });
    }
    return answer({ behavior: "allow", updatedInput: input });
  },
);

await server.connect(new StdioServerTransport());
