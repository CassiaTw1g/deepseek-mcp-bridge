# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
