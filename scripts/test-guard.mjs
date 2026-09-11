#!/usr/bin/env node
/**
 * 文件工具的工作区边界回归测试。
 *
 * 这一层过去是不存在的:文件工具被 `--allowedTools` 预批准、审批服务又对所有
 * 非命令工具无条件放行,理由是「`--add-dir` 管着」。`--add-dir` 是**追加**可访问
 * 目录,不限制任何东西 —— 于是 `Read C:\Users\...\.env` 在一个工作区是
 * `D:\项目` 的任务里被静默放行。下面每一条断言对应的都是这一类越界。
 *
 * 纯函数,不碰真模型:`npm run test:guard`
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkToolPaths } from "../src/harness/file-guard.ts";

function withWorkspace(fn) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-guard-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const inside = (r) => assert.equal(r.ok, true, `应当放行,却被判越界:${r.reasons.join(";")}`);
const outside = (r) => assert.equal(r.ok, false, "应当判为越界,却被放行");

// 下面标了 winOnly 的几条,断言的是 **Win32 路径语义**:`C:\Users\x\.env` 在
// 大小写敏感的 POSIX 文件系统上是一个不含盘符的**相对**路径,会被正常解析到
// 工作区里面 —— 失败的是断言,不是被检查的代码。和 `test-sandbox.mjs` 里
// junction / 短名那几条同样的理由,同样只在 Windows 上跑。
const WIN = process.platform === "win32";
const winOnly = WIN ? false : "仅 Windows(Win32 路径语义)";

test("工作区内的相对路径放行 —— 这是绝大多数调用", () => {
  withWorkspace((ws) => {
    mkdirSync(join(ws, "src"), { recursive: true });
    writeFileSync(join(ws, "src", "a.ts"), "x", "utf8");
    for (const p of ["src/a.ts", "./src/a.ts", "src", "报告.md", "src/**/*.ts"]) {
      inside(checkToolPaths("Read", { file_path: p }, ws));
    }
  });
});

test("工作区内的绝对路径放行", () => {
  withWorkspace((ws) => {
    inside(checkToolPaths("Write", { file_path: join(ws, "new.txt") }, ws));
    inside(checkToolPaths("Edit", { file_path: resolve(ws) }, ws));
  });
});

test("`.` 是工作区自己,放行;`..` 是工作区之外,但按越界拒绝而不是按空路径", () => {
  withWorkspace((ws) => {
    // admit() 的 preflightLexical 会拒绝裸的 "." 和 "..";file-guard 先把相对
    // 路径解析成绝对路径,否则模型每次 Grep 传 path="." 都会转人工,任务卡死。
    inside(checkToolPaths("Grep", { pattern: "foo", path: "." }, ws));

    const up = checkToolPaths("Grep", { pattern: "foo", path: ".." }, ws);
    outside(up);
    // 拒绝理由必须是「在外面」,不能是「路径为空」—— 后者说明解析没生效,
    // 而那正是 "." 会被误判的那条路。
    assert.match(up.reasons[0], /根目录之外/);
  });
});

test("工作区外的绝对路径转人工 —— 这就是 P1-2 的洞", { skip: winOnly }, () => {
  withWorkspace((ws) => {
    const r = checkToolPaths("Read", { file_path: "C:\\Users\\someone\\.env" }, ws);
    outside(r);
    assert.equal(r.bad.length, 1);
    assert.match(r.reasons[0], /C:\\Users\\someone\\\.env/);
  });
});

test("拼出来的越界路径不放过 —— 词法前缀测试挡不住它", () => {
  withWorkspace((ws) => {
    for (const p of [
      join(ws, "..", "..", "elsewhere.txt"),
      resolve(ws, ".."),
      resolve(ws, "..", "sibling", "x.txt"),
    ]) {
      outside(checkToolPaths("Read", { file_path: p }, ws));
    }
  });
});

test("前缀相同的兄弟目录不算在工作区里", () => {
  withWorkspace((ws) => {
    // 少了那个分隔符,`D:\ws-evil` 就能通过 `D:\ws` 的前缀检查 —— 这一类代码里
    // 最常见的实现缺陷。
    outside(checkToolPaths("Read", { file_path: ws + "-evil\\secret.txt" }, ws));
  });
});

test("UNC 路径一律拒绝,且不经过网络解析", { skip: winOnly }, () => {
  withWorkspace((ws) => {
    const r = checkToolPaths("Read", { file_path: "\\\\attacker\\share\\x" }, ws);
    outside(r);
    assert.match(r.reasons[0], /UNC|设备命名空间/);
  });
});

test("NTFS 备用数据流不算工作区内的普通文件", { skip: winOnly }, () => {
  withWorkspace((ws) => {
    outside(checkToolPaths("Read", { file_path: join(ws, "notes.txt:payload") }, ws));
  });
});

test("多个路径里只要有一个越界就转人工", { skip: winOnly }, () => {
  withWorkspace((ws) => {
    const r = checkToolPaths("Read", { file_path: [join(ws, "ok.txt"), "C:\\Windows\\win.ini"] }, ws);
    outside(r);
    assert.deepEqual(r.bad, ["C:\\Windows\\win.ini"]);
  });
});

test("Glob 的 pattern 也按路径检查,但它相对工作区", { skip: winOnly }, () => {
  withWorkspace((ws) => {
    inside(checkToolPaths("Glob", { pattern: "**/*.md", path: ws }, ws));
    outside(checkToolPaths("Glob", { pattern: "C:\\Users\\**\\*.env", path: ws }, ws));
  });
});

test("Grep 的 pattern 是正则,不是路径 —— 不能被当成路径拒绝", () => {
  withWorkspace((ws) => {
    inside(checkToolPaths("Grep", { pattern: "^foo|bar$", path: ws }, ws));
  });
});

test("没有路径参数时放行(工具自己会用 cwd,而 cwd 就是工作区)", () => {
  withWorkspace((ws) => {
    inside(checkToolPaths("Grep", { pattern: "foo" }, ws));
    inside(checkToolPaths("TodoWrite", {}, ws));
  });
});
