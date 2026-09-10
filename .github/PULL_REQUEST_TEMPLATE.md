## Summary

<!-- What does this change, and why? One or two sentences. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Documentation
- [ ] Refactor / internal
- [ ] CI / tooling

## Related issue

<!-- e.g. Closes #12. Delete if none. -->

## How was this tested?

<!--
Describe what you actually ran. "Ran npm test" is fine for a typecheck-level
change; a behaviour change needs the real HTTP path (`npm run start` +
`npm run tunnel` + `npm run smoke`) or an explicit note that you could not.
-->

- [ ] `npm test` passes (typecheck + selftest:memory)
- [ ] I tested the affected behaviour, or explain below why I could not

## Checklist

- [ ] One logical change; no unrelated refactors bundled in
- [ ] Comments explain *why*, not *what*
- [ ] No secrets committed (`.env`, keys, path secrets, tunnel URLs)
- [ ] Security model unchanged or strengthened (capability URL, loopback binding, rate limiting, read-only tool)

<!--
If this changes the `deepseek_flash` tool description, note it explicitly and
explain why the new wording routes better — that field is the router the calling
model reads.
-->
