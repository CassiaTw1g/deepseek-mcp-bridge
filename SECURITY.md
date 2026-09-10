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

### Known limitations — accepted, by design

- **Possession of the URL is sufficient access.** There is no per-request authentication beyond the path secret. This is a constraint of the ChatGPT connector UI, not an oversight. Mitigate with a dedicated API key, a spend cap at the provider, and rate limiting.
- **No confidentiality of prompt content.** Anything you send is forwarded to the DeepSeek API and is subject to their data policies. Do not send secrets.
- **The tool is read-only.** It returns text and has no filesystem access. It cannot read or write local files.
- **Rate-limit state is in-memory.** It is per-process and resets on restart. It is a speed bump, not a hard quota.

### Operator checklist

Before exposing the bridge:

1. Use a **dedicated** DeepSeek API key. Do not reuse a key other tools depend on.
2. Set a **spend cap** on that key in the DeepSeek console. This is the last line of defence.
3. Keep `HOST=127.0.0.1`. Do not set `0.0.0.0`.
4. Rotate `MCP_PATH_SECRET` with `npm run ctl -- secret` if the URL may have leaked, then update the connector URL.
5. Never commit `.env`. It is gitignored by default — keep it that way.

## Supported versions

Only the latest release on the default branch receives fixes. There are no backport branches.
