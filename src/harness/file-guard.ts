import { isAbsolute, resolve } from "node:path";
import { admit, createPolicy } from "../sandbox.ts";

/**
 * Where a file tool is allowed to point.
 *
 * The workspace boundary used to exist only on the way *in*: `agent_start`
 * validated its `workspace` argument, and everything after that was governed by
 * Claude Code's `--add-dir` — which **adds** a directory to the allowed set, and
 * adds nothing else. File tools were pre-approved with no path qualifier and
 * the approval MCP waved every non-command tool through on the theory that
 * `--add-dir` was the wall. It is not a wall: a job whose workspace was
 * `D:\项目` could `Read D:\项目\..\..\Users\...\.env` — or any absolute path —
 * without a human ever seeing it.
 *
 * So the same check `agent_start` performs on the workspace is applied here to
 * every path a file tool names. It is deliberately the *same* function
 * (`sandbox.admit`), so junctions, 8.3 short names, UNC paths, alternate data
 * streams and trailing-dot tricks are handled once, in the one place that has
 * tests for them.
 *
 * What this is NOT, and the README says so in the same words: a wall against a
 * model that has decided to read outside the workspace. `node` is pre-approved
 * by design — that is what `EXTRA_SYSTEM_PROMPT` steers every multi-statement
 * job toward — and `node -e "..."` reads anything this account can read. This
 * closes the *default* path, the one a prompt-injected file gets to use with no
 * human in the loop, and turns everything else into a visible stop.
 */

export interface ToolPathCheck {
  ok: boolean;
  /** Verbatim offending values, in the order they were checked. */
  bad: string[];
  /** One line per offending value, for the request a human reads. */
  reasons: string[];
}

/** Input keys that name a path. `Grep`/`Glob` also take a directory in `path`. */
const PATH_KEYS = ["file_path", "notebook_path", "path", "dir_path", "directory", "glob"];

/** `Glob` names its wildcard `pattern`; for `Grep` the same key is a regex. */
const PATTERN_IS_A_PATH = new Set(["glob"]);

/**
 * Pure apart from `realpath`, which is the point (see `sandbox.ts`): a lexical
 * prefix test is exactly what a junction inside the workspace defeats.
 *
 * A relative value is resolved against the workspace — it belongs to it by
 * definition — and that also keeps `"."`, `".."` and `"src/**\/*.md"` from
 * tripping `preflightLexical`'s rejection of bare dots. An absolute value is
 * checked as given: `C:\Users\...` from inside `D:\ws` must not silently
 * become `D:\ws\C:\Users\...`.
 */
export function checkToolPaths(
  toolName: string,
  input: Record<string, unknown>,
  workspace: string,
): ToolPathCheck {
  const policy = createPolicy([workspace]);
  const bad: string[] = [];
  const reasons: string[] = [];
  const seen = new Set<string>();

  const keys = PATTERN_IS_A_PATH.has(toolName.toLowerCase()) ? [...PATH_KEYS, "pattern"] : PATH_KEYS;

  for (const key of keys) {
    const value = input[key];
    const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    for (const raw of values) {
      if (typeof raw !== "string" || !raw.trim() || seen.has(raw)) continue;
      seen.add(raw);
      const target = isAbsolute(raw) ? raw : resolve(workspace, raw);
      const admitted = admit(policy, target);
      if (!admitted.ok) {
        bad.push(raw);
        reasons.push(`${raw} —— ${admitted.reason}`);
      }
    }
  }

  return { ok: bad.length === 0, bad, reasons };
}
