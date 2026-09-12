#!/usr/bin/env node
/**
 * Tests for the first-run wizard's pure half (`scripts/setup.mjs`).
 *
 * The wizard's own flow needs a terminal and writes `.env`, so it is not under
 * test. What is under test is the part that fails *quietly*: a URL that gets
 * `/v1` twice, a 404 reported as a bad key, a message that exists in one
 * language only, a line of text that leaks the operator's own domain into the
 * public repository.
 *
 * Run: npm run test:setup
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLAUDE_BIN_RELATIVE,
  LANGS,
  PROVIDER_PRESETS,
  anthropicBase,
  claudeExeName,
  classifyProbe,
  detectLang,
  keySummary,
  looksLikeHost,
  looksLikeHttpUrl,
  messageKeys,
  messagesUrl,
  normalizeHost,
  normalizeLang,
  probeUsable,
  shortDetail,
  t,
} from "./setup.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("both languages define exactly the same keys", () => {
  const zh = messageKeys();
  assert.ok(zh.length > 40, `expected a substantial table, got ${zh.length}`);
  for (const lang of LANGS) {
    for (const key of zh) {
      // t() throws on a missing key, which is the assertion.
      assert.doesNotThrow(() => t(lang, key), `${lang} is missing "${key}"`);
    }
  }
});

test("every message says something in every language", () => {
  // Blank entries are legal inside a block — they are the paragraph breaks —
  // so the requirement is one line of actual text, not all of them.
  for (const lang of LANGS) {
    for (const key of messageKeys()) {
      const value = t(lang, key);
      const parts = Array.isArray(value) ? value : [value];
      assert.ok(parts.length > 0, `${lang}.${key} is an empty array`);
      for (const line of parts) assert.equal(typeof line, "string", `${lang}.${key} is not a string`);
      assert.ok(
        parts.some((line) => line.length > 0),
        `${lang}.${key} is entirely blank`,
      );
    }
  }
});

test("t() interpolates named variables", () => {
  assert.equal(t("zh", "q.model.ok", { model: "abc" }), "✅ 通了:abc 正常应答。");
  assert.equal(t("en", "q.model.ok", { model: "abc" }), "✅ Works: abc answered.");
});

test("t() leaves an unknown placeholder alone rather than printing undefined", () => {
  assert.match(t("en", "q.model.ok"), /\{model\}/);
});

test("t() throws on an unknown key", () => {
  assert.throws(() => t("en", "no.such.key"), /no message for/);
});

test("t() falls back to English for a language we do not speak", () => {
  assert.equal(t("fr", "done.title"), t("en", "done.title"));
});

test("normalizeLang accepts locale tags and rejects anything else", () => {
  assert.equal(normalizeLang("zh"), "zh");
  assert.equal(normalizeLang("zh-CN"), "zh");
  assert.equal(normalizeLang("zh_TW"), "zh");
  assert.equal(normalizeLang("ZH-hans-CN"), "zh");
  assert.equal(normalizeLang("en-US"), "en");
  assert.equal(normalizeLang("fr"), null);
  assert.equal(normalizeLang(""), null);
  assert.equal(normalizeLang(undefined), null);
});

test("detectLang prefers explicit, then env, then locale, then English", () => {
  assert.equal(detectLang({ explicit: "en", env: "zh", locale: "zh-CN" }), "en");
  assert.equal(detectLang({ env: "en", locale: "zh-CN" }), "en");
  assert.equal(detectLang({ locale: "zh-CN" }), "zh");
  assert.equal(detectLang({ locale: "de-DE" }), "en");
  assert.equal(detectLang({}), "en");
  // The case this exists for: a Chinese Windows with no overrides.
  assert.equal(detectLang({ locale: "zh-Hans-CN" }), "zh");
});

test("anthropicBase mirrors what the harness appends", () => {
  // src/harness/claude-code.ts: `${DEEPSEEK_BASE_URL}/anthropic`
  assert.equal(anthropicBase("https://api.deepseek.com"), "https://api.deepseek.com/anthropic");
  assert.equal(anthropicBase("https://api.deepseek.com/"), "https://api.deepseek.com/anthropic");
  assert.equal(anthropicBase("https://api.deepseek.com///"), "https://api.deepseek.com/anthropic");
  // BRIDGE_ANTHROPIC_BASE_URL wins outright, and gets no /anthropic of its own.
  assert.equal(anthropicBase("https://api.deepseek.com", "https://proxy.internal"), "https://proxy.internal");
  assert.equal(anthropicBase("https://api.deepseek.com", "https://proxy.internal/"), "https://proxy.internal");
  assert.equal(anthropicBase("https://api.deepseek.com", "   "), "https://api.deepseek.com/anthropic");
  assert.equal(PROVIDER_PRESETS.deepseek.base, "https://api.deepseek.com");
});

test("messagesUrl never doubles a /v1 the operator already typed", () => {
  assert.equal(
    messagesUrl("https://api.deepseek.com/anthropic"),
    "https://api.deepseek.com/anthropic/v1/messages",
  );
  assert.equal(messagesUrl("https://api.deepseek.com/anthropic/"), "https://api.deepseek.com/anthropic/v1/messages");
  assert.equal(messagesUrl("https://host/anthropic/v1"), "https://host/anthropic/v1/messages");
  assert.equal(messagesUrl("https://host/anthropic/v1/"), "https://host/anthropic/v1/messages");
});

test("classifyProbe maps the statuses that actually mean something here", () => {
  assert.equal(classifyProbe(0), "network");
  assert.equal(classifyProbe(200), "ok");
  assert.equal(classifyProbe(201), "ok");
  assert.equal(classifyProbe(401), "badKey");
  assert.equal(classifyProbe(403), "badKey");
  assert.equal(classifyProbe(404), "badBase");
  assert.equal(classifyProbe(429), "rateLimited");
  assert.equal(classifyProbe(400), "badRequest");
  assert.equal(classifyProbe(422), "badRequest");
  assert.equal(classifyProbe(500), "server");
  assert.equal(classifyProbe(503), "server");
  assert.equal(classifyProbe(418), "unknown");
});

test("probeUsable treats a throttled key as usable and everything else as not", () => {
  assert.equal(probeUsable("ok"), true);
  assert.equal(probeUsable("rateLimited"), true);
  for (const code of ["network", "badKey", "badBase", "badRequest", "server", "unknown"]) {
    assert.equal(probeUsable(code), false, `${code} must not count as usable`);
  }
});

test("keySummary reports shape without ever carrying the value", () => {
  const key = "sk-abcdefghijklmnopqrstuvwxyz012345";
  const summary = keySummary(key);
  assert.equal(summary.length, key.length);
  assert.equal(summary.looksDeepSeek, true);
  assert.ok(!JSON.stringify(summary).includes(key));
  assert.ok(!JSON.stringify(summary).includes("abcdef"));

  assert.equal(keySummary("").length, 0);
  assert.equal(keySummary(undefined).looksDeepSeek, false);
  assert.equal(keySummary("abc").looksDeepSeek, false);
});

test("normalizeHost strips the scheme, the path and the case", () => {
  assert.equal(normalizeHost("mcp.example.com"), "mcp.example.com");
  assert.equal(normalizeHost("https://mcp.example.com"), "mcp.example.com");
  assert.equal(normalizeHost("https://mcp.example.com/"), "mcp.example.com");
  assert.equal(normalizeHost("https://mcp.example.com/mcp/abc"), "mcp.example.com");
  assert.equal(normalizeHost("  MCP.Example.COM  "), "mcp.example.com");
  assert.equal(normalizeHost(""), "");
});

test("looksLikeHost accepts real hostnames and rejects what people actually mistype", () => {
  for (const good of ["mcp.example.com", "https://mcp.example.com", "a.b.c.example.co.uk", "x1.example.com"]) {
    assert.equal(looksLikeHost(good), true, `${good} should be accepted`);
  }
  for (const bad of ["", "localhost", "example", "mcp..example.com", "-mcp.example.com", "mcp.example.com:8787"]) {
    assert.equal(looksLikeHost(bad), false, `${bad} should be rejected`);
  }
});

test("looksLikeHttpUrl only accepts a real http(s) base", () => {
  assert.equal(looksLikeHttpUrl("https://api.deepseek.com"), true);
  assert.equal(looksLikeHttpUrl("http://127.0.0.1:8787"), true);
  assert.equal(looksLikeHttpUrl("api.deepseek.com"), false);
  assert.equal(looksLikeHttpUrl("ftp://api.deepseek.com"), false);
  assert.equal(looksLikeHttpUrl(""), false);
});

test("shortDetail collapses whitespace and truncates", () => {
  assert.equal(shortDetail("  a\n\n b \t c "), "a b c");
  assert.equal(shortDetail("abcdef", 3), "abc…");
  assert.equal(shortDetail(undefined), "");
});

test("the Claude Code search paths still match the harness's own", () => {
  // `setup.mjs` duplicates `resolveBin` from `src/harness/claude-code.ts` on
  // purpose (that file needs node_modules; the wizard must run before
  // `npm install`). Duplication is only safe if something notices when it
  // drifts, so this reads the harness and checks the same paths are in there.
  const harness = readFileSync(join(ROOT, "src", "harness", "claude-code.ts"), "utf8");
  for (const relative of CLAUDE_BIN_RELATIVE) {
    for (const segment of relative.split("/")) {
      assert.ok(
        harness.includes(`"${segment}"`),
        `claude-code.ts no longer mentions "${segment}" — the wizard's search paths have drifted`,
      );
    }
  }
  assert.equal(claudeExeName("win32"), "claude.exe");
  assert.equal(claudeExeName("linux"), "claude");
});

test("no wizard message names a real host", () => {
  // Red line: the deployer's real hostname lives in .env and nowhere else.
  //
  // This test used to spell that hostname out — which made the guard itself the
  // leak, one copy of the very string it existed to keep out of the repository.
  // So it has no forbidden value: every hostname that reaches a user's screen
  // must be a placeholder or a public vendor, and anything else fails. The
  // operator's own domain is caught by not being on this list, and this file
  // now says nothing about what it is.
  //
  // Scope is the message table — the strings the wizard actually prints. A
  // whole-repo hostname scan is not usable: `options.co`, `err.me` and friends
  // in ordinary identifiers all match a hostname pattern.
  const ALLOWED = new Set([
    // placeholders — the shapes the docs and examples use
    "example.com",
    "api.example.com",
    "mcp.example.com",
    // public vendors a user may legitimately be told to visit
    "api.deepseek.com",
    "platform.deepseek.com",
    "chatgpt.com",
    "registry.npmmirror.com",
  ]);
  const HOST = /(?:^|[^\w.-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?::\d+)?/gi;

  for (const lang of LANGS) {
    for (const key of messageKeys()) {
      const value = t(lang, key);
      const text = (Array.isArray(value) ? value : [value]).join("\n");
      for (const [, host] of text.matchAll(HOST)) {
        assert.ok(
          ALLOWED.has(host.toLowerCase()),
          `${lang}.${key} prints the host "${host}" — a real hostname belongs in .env, ` +
            `never in a shipped string (add it here only if it is a placeholder or a public vendor)`,
        );
      }
    }
  }
});
