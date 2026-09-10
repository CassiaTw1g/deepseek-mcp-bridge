#!/usr/bin/env node
/**
 * 任务注册表 + agent 工具的离线测试。
 *
 * 这里防的都是「看起来能跑、真跑起来会丢任务」的缺陷,其中第一条是本项目
 * 里最高价值的一条测试 —— 详见下面的注释。
 *
 * 跑法:npm run test:jobs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";
import { createRegistry } from "../src/agent/jobs.ts";
import { createPolicy } from "../src/sandbox.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tempState() {
  return mkdtempSync(join(tmpdir(), "bridge-jobs-"));
}

// --- 最高价值的一条 ---------------------------------------------------------

test("客户端断线不得杀掉任务 —— 任务必须有自己的 AbortController", async () => {
  // MCP SDK 在客户端断开时会 abort 当前请求处理器的 signal。`agent_start`
  // 有一个 45 秒的同步等待窗口,而 ChatGPT 的工具调用上限约 60 秒 —— 断线是
  // 常态,不是异常。如果那个 signal 被接到任务的控制器上,每一个没耐心的
  // 调用方都会杀掉自己刚派出去的任务,而且是静默的:
  // 调用方已经走了,没人会看到错误。
  const stateDir = tempState();
  let jobSignal = null;
  let finished = false;

  const registry = createRegistry(
    async (_input, ctx) => {
      jobSignal = ctx.signal;
      await sleep(600);
      finished = true;
      return { text: "做完了", steps: 1 };
    },
    { stateDir },
  );

  const server = createMcpServer(registry, createPolicy([ROOT]));
  const client = new Client({ name: "t", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);

  // Not awaited later on purpose: once the client is gone there is nobody to
  // deliver a response to, and the SDK retries for the full sync window. The
  // job's own outcome is what this test is about.
  void client
    .callTool({ name: "deepseek_agent_start", arguments: { task: "测试任务", workspace: ROOT } })
    .catch(() => undefined);

  await sleep(150);
  assert.ok(jobSignal, "任务应当已经启动");
  assert.equal(jobSignal.aborted, false);

  // 模拟 ChatGPT 挂断:关掉客户端,服务端随即收到断开。
  await client.close();
  await sleep(150);

  assert.equal(jobSignal.aborted, false, "断线把任务的 signal 弄成 aborted 了 —— 任务会被静默杀死");

  await sleep(700);
  assert.equal(finished, true, "任务应当继续跑完,而不是随调用方一起消失");

  const jobs = registry.list();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].state, "done", `任务最终状态应为 done,实际 ${jobs[0].state}`);
  assert.ok(jobs[0].nonce, "结果必须带验证码");

  registry.shutdown();
  await server.close();
  rmSync(stateDir, { recursive: true, force: true });
});

// --- 取消哨兵 ---------------------------------------------------------------

test("cancel 文件能让运行中的任务停下", async () => {
  const stateDir = tempState();
  let observed = false;

  const registry = createRegistry(
    async (_input, ctx) => {
      // 真实的 harness 每 500ms 查一次;这里等一会儿再查。
      await sleep(400);
      observed = ctx.checkCancelled();
      if (observed) throw new Error("任务被取消。");
      return { text: "本不该跑到这里", steps: 1 };
    },
    { stateDir },
  );

  const job = registry.start({ task: "t", mode: "code", workspace: ROOT });
  writeFileSync(join(stateDir, "cancel", `${job.id}.json`), "{}", "utf8");

  await job.settled;
  assert.equal(observed, true, "运行中的任务必须能看见 cancel 哨兵");
  assert.equal(job.state, "cancelled");
  rmSync(stateDir, { recursive: true, force: true });
});

test("取消一个还没开始的任务,不会让它变成 done", async () => {
  const stateDir = tempState();
  const registry = createRegistry(
    async (_input, _ctx) => {
      await sleep(300);
      return { text: "晚了", steps: 1 };
    },
    { stateDir },
  );

  const job = registry.start({ task: "t", mode: "code", workspace: ROOT });
  assert.equal(job.state, "running");
  registry.shutdown();
  await job.settled;
  assert.notEqual(job.state, "done", "被取消的任务绝不能报成完成");
  rmSync(stateDir, { recursive: true, force: true });
});

// --- 上限 -------------------------------------------------------------------

test("并发上限挡住第三个任务,而不是默默排队", () => {
  const stateDir = tempState();
  const registry = createRegistry(async () => {
    await sleep(500);
    return { text: "x", steps: 1 };
  }, { stateDir, maxConcurrent: 2 });

  registry.start({ task: "1", mode: "code", workspace: ROOT });
  registry.start({ task: "2", mode: "code", workspace: ROOT });
  assert.throws(
    () => registry.start({ task: "3", mode: "code", workspace: ROOT }),
    /上限/,
    "超限时必须明确报错 —— 静默排队会让调用方以为任务已经在跑",
  );
  registry.shutdown();
  rmSync(stateDir, { recursive: true, force: true });
});

test("墙钟硬上限会中止一个不肯结束的任务", async () => {
  const stateDir = tempState();
  const registry = createRegistry(
    async (_input, ctx) => {
      // 一个会一直跑下去的 harness。硬上限是最后一个兜底。
      for (let i = 0; i < 200; i++) {
        if (ctx.signal.aborted) throw new Error("被中止");
        await sleep(50);
      }
      return { text: "不该到这里", steps: 1 };
    },
    { stateDir, hardWallMs: 300 },
  );

  const job = registry.start({ task: "t", mode: "code", workspace: ROOT });
  await job.settled;
  assert.equal(job.state, "error");
  assert.match(job.error, /硬上限/);
  rmSync(stateDir, { recursive: true, force: true });
});

// --- 落盘快照 ---------------------------------------------------------------

test("任务快照写到磁盘,ctl 才能看见它", async () => {
  const stateDir = tempState();
  const registry = createRegistry(async () => ({ text: "结果文本", steps: 3 }), { stateDir });
  const job = registry.start({ task: "落盘测试", mode: "code", workspace: ROOT });
  await job.settled;

  const raw = JSON.parse(readFileSync(join(stateDir, "jobs", `${job.id}.json`), "utf8"));
  assert.equal(raw.state, "done");
  assert.equal(raw.nonce, job.nonce);
  assert.equal(raw.workspace, ROOT);
  // AbortController 和 promise 不能进 JSON —— 循环引用会直接抛错,
  // 而这个写入发生在 settle 路径上,抛错就等于任务永远结束不了。
  assert.equal(raw.controller, undefined);
  assert.equal(raw.settled, undefined);
  rmSync(stateDir, { recursive: true, force: true });
});

test("任务失败时,错误原文被保留下来", async () => {
  const stateDir = tempState();
  const registry = createRegistry(async () => {
    throw new Error("DeepSeek 返回 400:reasoning_content 缺失");
  }, { stateDir });
  const job = registry.start({ task: "t", mode: "code", workspace: ROOT });
  await job.settled;
  assert.equal(job.state, "error");
  assert.match(job.error, /reasoning_content/);
  rmSync(stateDir, { recursive: true, force: true });
});
