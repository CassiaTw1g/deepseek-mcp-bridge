# Contributing

Thanks for considering a contribution. This project is small and deliberately so — please read the scope notes before opening a PR.

## Ways to contribute

- **Bug reports** — open an issue using the bug report template.
- **Feature requests** — open an issue using the feature request template. Describe the problem, not just the solution.
- **Pull requests** — see below.

If you are unsure whether something is in scope, open an issue first. It is cheaper for everyone than a rejected PR.

## Development setup

```bash
git clone https://github.com/CassiaTw1g/modelbridge.git
cd modelbridge
npm install
cp .env.example .env
npm run ctl -- secret     # writes MCP_PATH_SECRET into .env
```

You need Node.js >= 24. There is no build step — the runtime strips TypeScript types natively.

To work on the server without a DeepSeek key or a tunnel:

```bash
npm run selftest:memory   # in-memory MCP round trip, no network
npm run typecheck
```

To exercise the real HTTP path end to end you *do* need a key and, for the public-URL check, a tunnel:

```bash
npm run start
npm run tunnel
npm run smoke
```

## Before you open a PR

Run the same checks CI does:

```bash
npm test    # typecheck + selftest:memory
```

Both must pass. A PR that does not typecheck will not be reviewed.

## Guidelines

- **Keep the scope tight.** One logical change per PR. Do not bundle a refactor with a feature.
- **One tool, not many.** The bridge deliberately exposes a single tool (`deepseek_flash`). Fewer tools means fewer routing mistakes by the calling model. Adding tools needs a strong justification.
- **The tool description is load-bearing.** It is the router the calling model reads. If you change it, explain in the PR *why* the new wording routes better.
- **Do not weaken the security model.** Specifically: do not make the bare `/mcp` path respond, do not default `HOST` to a non-loopback address, do not remove rate limiting, and do not log secrets. See [SECURITY.md](SECURITY.md).
- **Comments explain *why*, not *what*.** A comment that restates the code will be asked to be removed.
- **Match the existing style** — 2-space indent, `lf` line endings in `.ts`/`.mjs` (see `.editorconfig`). Batch files under `windows/` are the exception: they must be CRLF and ASCII-only.
- **Windows gotchas are real.** `curl` in git-bash mangles non-ASCII request bodies; that is why tests use Node's `fetch`. Do not add curl-based tests.

## Commit messages

Use a short imperative subject line, optionally with a conventional-commit prefix:

```
fix: retry once when DeepSeek returns empty content
docs: clarify the capability-URL model in README
feat: add --foreground flag to start
```

Explain the *why* in the body when it is not obvious from the subject.

## Reporting security issues

Do **not** open a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md).

## Code of Conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
