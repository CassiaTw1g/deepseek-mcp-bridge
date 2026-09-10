import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";

/**
 * The only place a caller-supplied string becomes a real filesystem path.
 *
 * Everything here exists because on Windows a path is not the thing it looks
 * like. Win32 silently strips trailing dots and spaces, `realpath` is the only
 * normaliser that resolves junctions and 8.3 short names, UNC paths reach out
 * over SMB *while being resolved*, and NTFS alternate data streams live in a
 * colon that no directory-walking logic ever sees. Each check below names the
 * trick it defeats; none of them are theoretical.
 *
 * The honest boundary: this constrains *paths*. It does not constrain
 * `run_command`, because argv[0] is a program name resolved from PATH, not a
 * path at all. Program-level containment is the allowlist's job, and a program
 * allowlist that admits an interpreter admits arbitrary code.
 */

export type DenyCode = "EMPTY" | "UNC" | "DEVICE" | "ADS" | "RESERVED" | "OUTSIDE";

export type Admit =
  | { ok: true; realPath: string; root: string }
  | { ok: false; code: DenyCode; reason: string };

export interface SandboxPolicy {
  /** Canonical, lowercased, no trailing separator. */
  roots: string[];
  maxReadBytes: number;
}

const WIN = process.platform === "win32";

// `CON.txt` is as reserved as `CON` — the extension does not save it.
const RESERVED = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

function deny(code: DenyCode, reason: string): Admit {
  return { ok: false, code, reason };
}

function canonical(p: string): string {
  let out = normalize(resolve(p));
  while (out.length > 1 && out.endsWith(sep)) out = out.slice(0, -1);
  return WIN ? out.toLowerCase() : out;
}

/** Split a path into components, ignoring the drive/root prefix. */
function components(p: string): string[] {
  return p.split(/[\\/]+/).filter((c) => c.length > 0 && !/^[A-Za-z]:$/.test(c));
}

/**
 * Pure. Runs before anything touches the filesystem, which is the whole point:
 * resolving `\\attacker\share\x` opens an SMB connection and hands the
 * attacker this machine's NTLM hash. The check has to happen first, not after.
 */
export function preflightLexical(raw: string): Admit {
  if (typeof raw !== "string") return deny("EMPTY", "路径必须是字符串。");
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return deny("EMPTY", "路径为空。");

  // `\\server\share` (UNC, leaks credentials over SMB), `\\?\` (disables Win32
  // normalisation), `\\.\` (raw device namespace: PhysicalDrive0, pipes).
  // All three begin with two separators.
  //
  // `\??\` is the native form of the device namespace and begins with only
  // *one* separator, so the check above misses it — it has to be named
  // separately, and it has to run before the ADS check below, which would
  // otherwise claim it on account of the colon.
  const isDeviceNamespace = /^[\\/]{2}/.test(trimmed) || /^[\\/]\?\?[\\/]/.test(trimmed);
  if (isDeviceNamespace) {
    return deny("UNC", "拒绝 UNC / 设备命名空间路径(\\\\server、\\\\?\\、\\\\.\\、\\??\\)。");
  }

  // A colon is legal only as the drive letter's own separator (`D:\…`).
  const afterDrive = /^[A-Za-z]:/.test(trimmed) ? trimmed.slice(2) : trimmed;
  if (afterDrive.includes(":")) {
    return deny("ADS", "路径中包含冒号,可能是 NTFS 备用数据流(如 notes.txt:payload)。");
  }

  for (const raw_component of components(trimmed)) {
    // Win32 ignores trailing dots and spaces, so `secret.txt.` opens
    // `secret.txt`. Strip them before comparing anything.
    const name = raw_component.replace(/[. ]+$/, "");
    if (!name) continue;
    const stem = name.split(".")[0];
    if (RESERVED.has(stem.toLowerCase())) {
      return deny("RESERVED", `组件 "${raw_component}" 是保留设备名(${stem.toUpperCase()})。`);
    }
  }

  return { ok: true, realPath: trimmed, root: "" };
}

/**
 * Resolve `raw` and confirm it lands inside one of the policy's roots.
 *
 * The subtlety is that `realpath` fails on a path that does not exist yet, so
 * a write to `link/newdir/f.txt` — where `link` is a junction into the user's
 * profile — cannot be resolved directly. Walking up to the deepest *existing*
 * ancestor, resolving that, then re-joining the tail is what closes the hole;
 * a purely lexical check passes it happily.
 */
export function admit(policy: SandboxPolicy, raw: string): Admit {
  const pre = preflightLexical(raw);
  if (!pre.ok) return pre;

  const target = isAbsolute(pre.realPath) ? pre.realPath : resolve(policy.roots[0] ?? process.cwd(), pre.realPath);

  // Walk up until something exists, then resolve that.
  let existing = target;
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) {
    if (existsSync(existing)) break;
    const parent = resolve(existing, "..");
    if (parent === existing) break;
    tail.unshift(existing.slice(parent.length).replace(/^[\\/]+/, ""));
    existing = parent;
  }

  let realExisting: string;
  try {
    realExisting = realpathSync(existing);
  } catch {
    return deny("OUTSIDE", `无法解析路径:${existing}`);
  }

  const real = canonical(tail.length ? join(realExisting, ...tail) : realExisting);

  for (const root of policy.roots) {
    // The separator matters: without it `D:\workspace-evil` passes a prefix
    // test against `D:\workspace`. This is the most commonly shipped bug in
    // this whole class of code.
    if (real === root || real.startsWith(root + sep)) {
      return { ok: true, realPath: real, root };
    }
  }

  return deny("OUTSIDE", `路径落在允许的根目录之外:${real}`);
}

/** `DEEPSEEK_ALLOWED_ROOTS` — `;`-separated on Windows, `:`-separated elsewhere. */
export function parseRoots(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(WIN ? ";" : ":")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(canonical);
}

export function createPolicy(roots: string[], maxReadBytes = 256 * 1024): SandboxPolicy {
  return { roots: roots.map(canonical), maxReadBytes };
}
