#!/usr/bin/env node
/**
 * 沙盒逃逸回归测试。
 *
 * 每一条都对应一个真实的 Windows 路径陷阱,而不是假想的攻击。纯词法检查
 * 不需要文件系统;标了「需要真实路径」的会建临时目录来验证 realpath 行为。
 *
 * 跑法:npm run test:sandbox
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync, linkSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { admit, createPolicy, preflightLexical } from "../src/sandbox.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = join(ROOT, ".sandbox-test");
const WS = join(BASE, "ws");
const OUTSIDE = join(BASE, "outside");
const WS_OTHER = join(BASE, "wsother");

const WIN = process.platform === "win32";
const winOnly = WIN ? false : "仅 Windows";

function reset() {
  rmSync(BASE, { recursive: true, force: true });
  mkdirSync(WS, { recursive: true });
  mkdirSync(OUTSIDE, { recursive: true });
  mkdirSync(WS_OTHER, { recursive: true });
  writeFileSync(join(OUTSIDE, "secret.txt"), "TOP SECRET", "utf8");
}

const policy = () => createPolicy([WS]);

function codeOf(raw, p = policy()) {
  const r = admit(p, raw);
  return r.ok ? "OK" : r.code;
}

// --- 纯词法:不碰文件系统 ---------------------------------------------------

test("UNC 与设备命名空间一律拒绝(且必须先于任何文件系统调用)", () => {
  // 解析 \\attacker\share\x 会发起 SMB 连接,把你的 NTLM 哈希送出去。
  // 这类检查必须发生在 realpath 之前,否则「检查」本身就是攻击。
  assert.equal(codeOf("\\\\attacker\\share\\x"), "UNC");
  assert.equal(codeOf("//attacker/share/x"), "UNC");
  assert.equal(codeOf("\\\\?\\D:\\ws\\..\\..\\Windows"), "UNC");
  assert.equal(codeOf("\\\\.\\PhysicalDrive0"), "UNC");
  assert.equal(codeOf("\\\\.\\pipe\\anything"), "UNC");
  assert.equal(codeOf("\\??\\C:\\Windows"), "UNC");
});

test("NTFS 备用数据流被拒绝", () => {
  // STREAM 后缀不是路径组件,任何目录遍历逻辑都看不见它。
  assert.equal(codeOf(join(WS, "a.txt") + ":hidden"), "ADS");
  assert.equal(codeOf(join(WS, "a.txt") + ":$DATA"), "ADS");
});

test("保留设备名被拒绝,包括带扩展名的形式", () => {
  assert.equal(codeOf(join(WS, "CON")), "RESERVED");
  assert.equal(codeOf(join(WS, "con.txt")), "RESERVED");
  assert.equal(codeOf(join(WS, "NUL")), "RESERVED");
  assert.equal(codeOf(join(WS, "COM1")), "RESERVED");
  assert.equal(codeOf(join(WS, "sub", "LPT9.log")), "RESERVED");
});

test("空路径与点路径被拒绝", () => {
  for (const p of ["", "   ", ".", ".."]) assert.equal(codeOf(p), "EMPTY", JSON.stringify(p));
});

test("前缀检查必须带分隔符 —— D:\\wsother 不能靠 D:\\ws 蒙混过关", () => {
  reset();
  // 这是这类代码里最常被写错的一处:startsWith(root) 会放行同级目录。
  assert.equal(codeOf(WS_OTHER), "OUTSIDE");
  assert.equal(codeOf(join(WS_OTHER, "x.txt")), "OUTSIDE");
  assert.equal(codeOf(join(WS, "..", "wsother", "x.txt")), "OUTSIDE");
});

test("大小写不敏感 —— D:\\WS 就是 D:\\ws", () => {
  reset();
  const upper = WS.toUpperCase();
  assert.equal(codeOf(upper), "OK");
  assert.equal(codeOf(join(upper, "sub", "f.txt")), "OK");
});

test(".. 穿越逃不出去", () => {
  reset();
  assert.equal(codeOf(join(WS, "sub", "..", "..", "outside", "secret.txt")), "OUTSIDE");
  assert.equal(codeOf(join(WS, "..", "outside")), "OUTSIDE");
});

// --- 需要真实路径:realpath 行为 ---------------------------------------------

test("junction 逃逸:工作区里的链接指向别处", { skip: winOnly }, () => {
  reset();
  const link = join(WS, "link");
  symlinkSync(OUTSIDE, link, "junction");

  assert.equal(existsSync(join(link, "secret.txt")), true, "前提:链接确实能读到外面的文件");
  // 纯词法检查会放行(路径字符串确实以工作区开头),只有 realpath 能看穿。
  assert.equal(codeOf(join(link, "secret.txt")), "OUTSIDE");
});

test("经 junction 写新文件也必须被拒(最深的已存在祖先)", { skip: winOnly }, () => {
  reset();
  const link = join(WS, "link");
  symlinkSync(OUTSIDE, link, "junction");

  // link/newdir/f.txt 本身不存在,realpath 会直接 ENOENT。
  // 必须先向上走到「最深的已存在祖先」(link),解析它,再把尾巴接回去。
  // 这是这类实现里最常翻车的一条。
  assert.equal(codeOf(join(link, "newdir", "f.txt")), "OUTSIDE");
});

test("尾部点和空格会被 Win32 静默忽略,必须在比较前剥掉", { skip: winOnly }, () => {
  reset();
  writeFileSync(join(WS, "a.txt"), "inside", "utf8");
  // `a.txt.` 打开的就是 `a.txt`。所以这两种写法都必须解析到同一个文件。
  assert.equal(codeOf(join(WS, "a.txt.")), "OK");
  assert.equal(codeOf(join(WS, "a.txt ")), "OK");
  // 而一个越界的带尾点路径,不能因为尾点而绕过前缀检查。
  assert.equal(codeOf(join(WS, "..", "outside", "secret.txt.")), "OUTSIDE");
});

test("工作区内正常路径放行", { skip: winOnly }, () => {
  reset();
  writeFileSync(join(WS, "ok.txt"), "fine", "utf8");
  const r = admit(policy(), join(WS, "ok.txt"));
  assert.equal(r.ok, true);
  assert.equal(r.root, WS.toLowerCase());
});

test("路径比较使用规范形式,返回值可直接用于 fs 调用", { skip: winOnly }, () => {
  reset();
  writeFileSync(join(WS, "read-me.txt"), "yes", "utf8");
  const r = admit(policy(), join(WS, "READ-ME.TXT"));
  assert.equal(r.ok, true);
  assert.equal(readFileSync(r.realPath, "utf8"), "yes");
});

// --- 已知缺口:断言它成功,而不是假装不存在 ---------------------------------

test("硬链接是已接受缺口 —— 路径检查抓不到,只能靠跨卷布局缓解", { skip: winOnly }, () => {
  reset();
  const outsideFile = join(OUTSIDE, "secret.txt");
  const innocent = join(WS, "innocent.txt");
  try {
    linkSync(outsideFile, innocent);
  } catch (err) {
    // 跨卷时硬链接会失败 —— 那正是我们要推荐的工作区布局。
    assert.match(String(err.message), /EXDEV|cross-device|不同|volume/i);
    return;
  }

  // 硬链接不携带任何指向原路径的痕迹:`innocent.txt` 看起来完全在工作区内。
  // 记录为「放行」是诚实的做法。真正的缓解是硬链接不能跨卷 ——
  // 让工作区待在 D 盘、用户目录待在 C 盘,结构上就隔离了。
  const r = admit(policy(), innocent);
  assert.equal(r.ok, true, "已知并接受:路径检查无法识别硬链接");
  assert.equal(readFileSync(innocent, "utf8"), "TOP SECRET");
});

test("清理", () => {
  rmSync(BASE, { recursive: true, force: true });
});
