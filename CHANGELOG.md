# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Agent jobs.** `deepseek_agent_start` / `deepseek_agent_poll` turn the bridge from a one-shot Q&A tool into something that can be given a task and left to finish it: the sub-agent reads and edits files, runs commands, and iterates across steps until it is done. Jobs are asynchronous because a real task outlives ChatGPT's ~60 s tool-call budget; `agent_start` waits up to 45 s for a fast job and hands back a job id otherwise.
- **Claude Code as the harness.** A job spawns `claude --output-format stream-json` against the DeepSeek Anthropic-compatible endpoint, so the loop, context compaction, prompt caching and tool implementations are the ones Claude Code already ships rather than a hand-rolled imitation.
- **Out-of-band approval queue.** Commands outside `BRIDGE_APPROVE_ALLOW` pause the job instead of failing it. The prompt is a stdio MCP server owned by the harness process — deliberately *not* reachable over the capability URL, so a caller cannot approve its own commands. Unanswered requests deny; there is no default-allow path.
- **`src/sandbox.ts`**, the single place a caller-supplied string becomes a real path. Rejects UNC paths, `\\?\` device namespaces, NTFS alternate data streams, reserved device names, and trailing dots/spaces; resolves the deepest existing ancestor with `realpath` so junctions cannot walk out; requires a separator at the prefix boundary. `npm run test:sandbox` is the escape regression suite.
- **Job registry** (`src/agent/jobs.ts`): per-job `AbortController`, concurrency cap, wall-clock ceiling, step ceiling, on-disk snapshots, and a nonce that appears only in the final result — so a caller that cannot quote the nonce does not have a result.
- **New `ctl` commands**: `jobs`, `jobs <id> --trace`, `job kill <id>`, `pending`, `approve <id>`, `deny <id>`, `audit`.
- **`npm run accept`**, an acceptance suite that asks the real model three questions a chat-only model cannot answer: reproduce a random string that exists only in a file, debug a script that must be run before its bug is knowable, and admit that a file does not exist rather than inventing contents.
- **`npm run ctl -- rotate`.** A new secret, a server-only restart, and the new public URL on your clipboard. It leaves the tunnel alone — `npm run restart` kills it, which changes the public hostname and costs a second trip to the connector for no reason. On Windows, `windows/7-轮换密钥.bat` is the same thing from a double-click.
- **Two model-behaviour limits documented**, both found while validating the agent path end to end. A calling agent (ChatGPT) may refuse to dispatch a task that hands a local file to an external model and will ask for explicit authorisation. And a sub-agent will state, confidently and wrongly, that nothing left your machine — it cannot see its own hosting. See README troubleshooting and `SECURITY.md`.

### Changed

- `src/deepseek.ts` now returns the full assistant message (including `tool_calls` and `reasoning_content`) instead of a bare string; `callDeepSeek()` remains as a behaviourally identical wrapper.
- The empty-content retry no longer fires on a tool-call turn, where empty content is normal — previously each step of a tool loop would be sent twice.

### Fixed

- **Cancellation reported as failure.** A job stopped with `job kill` settled as `error`, telling the caller the sub-agent had crashed when a person had in fact stopped it.
- **45-second process leak per call.** `Promise.race` does not cancel its loser, so the synchronous-window timer kept the event loop alive long after every `agent_start` had returned.
- **The MCP server advertised a version this repository has never had.** It reported `2.0.0` while `package.json` said `1.0.0`, so every client was told the wrong thing. Now `1.0.0`, with a comment tying it to the package.
- **Every job record named a harness that had never run.** The `harness` field was the literal `"pending"`, which no code ever overwrote — so a record written after a successful run still claimed no harness had been picked. Whoever chooses the runner now supplies `harnessName`; the default is `"unknown"` rather than a state that reads as "still deciding".

## [1.0.0] - 2026-09-11

Initial release.

### Added

- MCP server exposing a single `deepseek_flash` tool over Streamable HTTP, stateless transport (`sessionIdGenerator: undefined`, fresh server + transport per request).
- Capability-URL authentication: the MCP endpoint lives at `/mcp/<secret>`; bare `/mcp` and wrong paths return 404.
- Per-IP sliding-window rate limiting (default 20/min).
- Loopback-only binding by default (`HOST=127.0.0.1`).
- Four task modes (`analyze`, `review`, `code`, `summarize`), each with its own system prompt; `review` explicitly treats any author conclusion in the material as an unverified claim.
- SSE response streaming to avoid Cloudflare's ~100 s edge (524) timeout on long calls.
- Automatic single retry when `deepseek-flash` returns empty `content` (reasoning-only output), with a descriptive error if both attempts are empty.
- Lifecycle CLI (`ctl.mjs`): `start`, `stop`, `restart`, `status`, `logs`, `enable`, `disable`, `tunnel`, `untunnel`, `uninstall`, `secret`.
- Cloudflare quick-tunnel management with `--protocol http2` (needed where QUIC is blocked) and automatic URL discovery.
- Verification: in-memory MCP self-test (`npm test`), public-endpoint smoke test using Node `fetch` (`npm run smoke`), and per-request access logging that distinguishes a real tool call from a narrated one.

[Unreleased]: https://github.com/CassiaTw1g/deepseek-mcp-bridge/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/CassiaTw1g/deepseek-mcp-bridge/releases/tag/v1.0.0
