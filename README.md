# deepseek-mcp-bridge

An MCP server that exposes **DeepSeek** as a tool for ChatGPT connectors (and any other MCP client).

[中文说明](README.zh-CN.md) · [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

---

## Why this exists

ChatGPT's sub-agent slots only accept OpenAI's own model tiers (Sol / Terra / Luna). You cannot register an external model as a sub-agent. The only supported entry point for a foreign model is an **MCP connector** — i.e. wrapping it as a **tool** that the main agent can call.

That has real consequences you should understand before deploying:

| | Native ChatGPT sub-agent | This bridge (DeepSeek as a tool) |
|---|---|---|
| Separate context | Yes | Yes (it only sees the prompt you send) |
| Independence | Separate session, same OpenAI stack | **Different vendor, different model — genuinely independent** |
| Parallelism | Yes | No — synchronous request/response |
| Result destination | Retained in its own session | Returns into the caller's context |
| Cost | Subscription credits | DeepSeek API, billed separately (very cheap) |

The main practical payoff is **cross-vendor independent review**. If your prompt requires that a reviewer must *not* reuse the implementer's conclusions, a model from a different vendor satisfies that requirement far better than another tier of the same stack — there is no shared training lineage to echo.

> The bridge is a standalone Node process. It does **not** run inside Claude Code, ChatGPT, or any host — it talks only to `api.deepseek.com`.

## Architecture

```
ChatGPT (Sol)  ──HTTPS──▶  Cloudflare edge  ──tunnel──▶  this bridge (localhost:8787)  ──▶  api.deepseek.com
     │                                                                                            │
     └── tool call: deepseek_flash(task, mode, files) ── text result returns to Sol's context ◀────┘
```

- **Transport**: MCP Streamable HTTP, stateless (`sessionIdGenerator: undefined`, a fresh server + transport per request so callers never share state).
- **Responses stream as SSE** rather than buffered JSON. This keeps bytes moving on the wire, which avoids Cloudflare's free-tier **524** timeout on long DeepSeek calls.
- **Auth**: a **capability URL**. The MCP endpoint is `/mcp/<64-hex-secret>`; the path *is* the credential. The bare `/mcp` path and any wrong path return **404**, indistinguishable from nothing being there — because ChatGPT's connector form has no Bearer-token field.

## Requirements

- Node.js **>= 24** (uses native TypeScript type-stripping; no build step)
- A DeepSeek API key — create one at <https://platform.deepseek.com>
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) for the quick tunnel (or bring your own deployment — see below)

## Quick start

```bash
git clone https://github.com/CassiaTw1g/deepseek-mcp-bridge.git
cd deepseek-mcp-bridge
npm install
cp .env.example .env
```

Edit `.env`:

1. Set `DEEPSEEK_API_KEY` to your key. **Use a dedicated key for this bridge** so it can be revoked independently, and set a spend cap on it in the DeepSeek console as a last line of defence.
2. Generate the path secret:

   ```bash
   npm run ctl -- secret
   ```

   This writes `MCP_PATH_SECRET=<random hex>` into `.env` (or prints it if `.env` doesn't exist yet).

Start the server and open the tunnel:

```bash
npm run start     # background server on 127.0.0.1:8787
npm run tunnel    # cloudflared quick tunnel; prints the public URL and the full MCP endpoint
```

`npm run tunnel` prints the exact URL to paste into ChatGPT:

```
公网端点 : https://<random>.trycloudflare.com/mcp/<your-secret>
```

### Register the connector

1. Open **ChatGPT on the web** (connectors cannot be configured from desktop or mobile).
2. **Settings → Plugins → MCP → Add server** (alternatively: Settings → Connectors → Advanced → Developer mode).
3. Type: **Streamable HTTP**. Authentication: **No authentication**.
4. URL: the **full** `https://<random>.trycloudflare.com/mcp/<your-secret>` — including the `/mcp/<secret>` path. Pasting only the domain will not work.
5. Save. The connector handshake shows up in the log as `server/discover → initialize → notifications/initialized → tools/list`.

### Tell your main agent when to use it

The tool description is the router. It states *dispatch conditions*, not just what the tool does — this is what prevents the calling agent from picking it arbitrarily. Add a rule to your system prompt that is **mutually exclusive** with your sub-agent rules, e.g.:

> Tasks needing cross-vendor independent review (security review, counterexample construction) → call the `deepseek_flash` tool, do not delegate to a sub-agent. Tasks needing file access, parallelism, or same-stack collaboration → delegate to a sub-agent.

## Tool reference

One tool is exposed. Fewer tools means fewer routing mistakes.

### `deepseek_flash`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `task` | string | yes | The concrete task. State the goal, constraints, and expected output format. For independent review, **do not reveal your own conclusion here** — it contaminates the independence. |
| `mode` | enum | no | `analyze` \| `review` \| `code` \| `summarize`. Selects the system prompt. Default `analyze`. |
| `files` | string | no | The code/text to analyse, passed through as plain text. The bridge **cannot access your filesystem** — content must be inlined here. |

Each `mode` gets a distinct system prompt. `review` explicitly instructs the model to treat any author conclusion in the material as an unverified claim and to state disagreements explicitly — that is the point of routing to an external vendor.

## Configuration

All via `.env` (gitignored):

| Variable | Default | Notes |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | **Required.** Use a dedicated key with a spend cap. |
| `MCP_PATH_SECRET` | — | **Required**, min 16 chars. The capability path segment. `npm run ctl -- secret` generates a 32-byte hex value. |
| `PORT` | `8787` | Local listen port. |
| `HOST` | `127.0.0.1` | Listen address. **Leave on loopback** — the tunnel runs on the same machine, so exposing the port to your LAN has no upside. |
| `RATE_LIMIT_PER_MINUTE` | `20` | Per-IP sliding window. Limits the blast radius if the URL leaks. |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | OpenAI-compatible endpoint. |
| `DEEPSEEK_MODEL` | `deepseek-flash` | Model ID. |
| `DEEPSEEK_TIMEOUT_MS` | `90000` | Server-side timeout; returns a structured error instead of hanging. Kept under Cloudflare's 100 s edge timeout. |
| `DEEPSEEK_MAX_OUTPUT_TOKENS` | `4096` | Output cap. `deepseek-flash` is a reasoning model: `reasoning_content` and `content` **share** this budget, so a task that over-reasons can starve the answer. |

## Lifecycle commands

```bash
npm run start      # background start (no-op if already running)
npm run stop       # stop server and tunnel
npm run restart    # restart server (stops the tunnel too — re-run `npm run tunnel`)
npm run status     # enabled state, PIDs, local + public endpoints
npm run logs       # last 40 log lines
npm run tunnel     # start the Cloudflare tunnel, print the public URL
npm run untunnel   # stop the tunnel only
npm run enable     # clear the disabled flag
npm run disable    # stop everything and set the disabled flag
npm run uninstall  # stop and clear local state (leaves the project directory)
```

`npm run start --foreground` runs in the foreground for debugging.

## Verification

Three layers, cheapest first.

**1. Memory transport self-test — no network, no key needed:**

```bash
npm test              # typecheck + in-memory MCP round trip
```

**2. Public endpoint smoke test — exercises the real HTTP path:**

```bash
npm run smoke                          # reads the tunnel URL from .state/tunnel.log
npm run smoke -- https://host/mcp/xxx  # or pass an endpoint explicitly
```

This asserts the health check, that a bare `/mcp` returns 404, that a wrong secret returns 404, and that a real `tools/call` returns non-empty content. It uses Node's `fetch`, **not** `curl` — see the Windows note below.

**3. Did ChatGPT actually call us?**

Server access logs and the chat transcript look identical whether the model truly called the tool or merely *narrated* doing so. The only trustworthy signals are:

- the log line `tools/call deepseek_flash` in `npm run logs`, and
- a matching entry in the DeepSeek console usage page.

If the chat shows a plausible answer but **both** are silent, the calling model role-played the call. Re-sharpen the tool description or your dispatch rule.

## Deployment options

The quick tunnel is fine to start, but its URL changes on every restart (you must re-edit the connector). For anything long-lived:

| Option | Cost | When |
|---|---|---|
| **cloudflared quick tunnel** | free | First run, validation. `--protocol http2` is required on networks where QUIC is blocked. |
| **Cloudflare Worker** | free | Stable URL, no local process. Rewrite the transport onto Hono's Web Standard variant; store the DeepSeek key as a Worker secret. |
| **VPS (HK / SG)** | ~$5–12/mo | Long-term stability, and the 100 s edge timeout disappears entirely. |

Avoid the ngrok free tier: its interstitial warning page requires an `ngrok-skip-browser-warning` header, which ChatGPT connectors cannot send, so the connection is severed.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `MCP_PATH_SECRET 未设置或过短` on start | Run `npm run ctl -- secret` to write one into `.env`. |
| ChatGPT shows "couldn't connect" | URL must include the full `/mcp/<secret>` path. Check `npm run status` for the current public endpoint. |
| 404 from the public URL | Wrong or stale secret. Restart after rotating, and update the connector URL. |
| Empty/blank reply from DeepSeek | `deepseek-flash` occasionally emits reasoning only, returning empty `content`. The bridge retries once automatically; if it still fails, raise `DEEPSEEK_MAX_OUTPUT_TOKENS` or split the task. |
| Truncated answer | Reasoning consumed the token budget (`finish_reason: "length"`). Raise the cap or narrow the task. |
| Cloudflare 524 | A single call exceeded the ~100 s edge timeout. Slow responses already stream as SSE; lower `DEEPSEEK_TIMEOUT_MS` or split the work. |
| Tunnel URL unreachable from your own machine | Local router DNS may not have the fresh `trycloudflare.com` subdomain yet. Confirm with `curl --resolve` against `1.1.1.1`; this affects only local checks, not ChatGPT. |
| **Windows / git-bash**: garbled results or token blowups | `curl` in git-bash re-encodes non-ASCII request bodies as GBK, so the model reasons over mojibake. Use `npm run smoke` (Node `fetch`) instead of `curl`. |

## Security model

Read this before exposing anything.

- **The path secret is the credential.** Anyone with the URL can spend your DeepSeek quota. Treat it like a password; rotate with `npm run ctl -- secret`.
- **Bind to loopback.** `HOST` defaults to `127.0.0.1`. Do not set `0.0.0.0`.
- **Rate limiting** is on by default and caps abuse if the URL leaks.
- **A DeepSeek spend cap** in the provider console is the final backstop — set it.
- **Use a separate API key.** Do not reuse a key that other tools depend on; a leaked bridge key should be revocable without collateral damage.
- The tool is **read-only**: it returns text and has no filesystem access.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
