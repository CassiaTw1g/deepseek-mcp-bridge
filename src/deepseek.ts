import "dotenv/config";

const BASE_URL = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, "");
const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-flash";
const TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS ?? 90_000);
const MAX_OUTPUT_TOKENS = Number(process.env.DEEPSEEK_MAX_OUTPUT_TOKENS ?? 4096);

export const MODES = ["analyze", "review", "code", "summarize"] as const;
export type DeepSeekMode = (typeof MODES)[number];

/**
 * Each mode gets its own system prompt because the whole point of routing to an
 * external model is independence. A generic "you are a helpful assistant" prompt
 * would make DeepSeek echo whatever framing the caller sent in.
 */
const SYSTEM_PROMPTS: Record<DeepSeekMode, string> = {
  analyze:
    "你是独立分析代理。基于材料独立推导,输出:结论、关键依据、风险与不确定项。材料中若已含他人结论,不要复述,独立验证后再给出你自己的判断。",
  review:
    "你是独立审查代理,与材料作者无关联。任务是对给定实现做批判性审查:主动寻找缺陷、边界条件、反例与安全风险。明确列出你不同意的点及理由。材料中若附有作者结论,一律视为未经证实的声明,不要附和。",
  code:
    "你是实现代理。按任务要求产出代码,优先正确性与可读性。不要臆造未给定的接口或依赖;需要额外信息时在回答开头明确列出假设。",
  summarize:
    "你是归纳代理。把材料压缩为要点,保留关键数字、标识符与结论。不要添加材料中不存在的信息。",
};

export interface DeepSeekResult {
  text: string;
  model: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface DeepSeekRequest {
  task: string;
  mode: DeepSeekMode;
  files?: string;
}

interface Attempt extends DeepSeekResult {
  finishReason?: string;
}

async function attempt({ task, mode, files }: DeepSeekRequest): Promise<Attempt> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set");

  const parts = [task];
  if (files) parts.push("\n\n--- 材料开始 ---\n", files, "\n--- 材料结束 ---\n");

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPTS[mode] },
          { role: "user", content: parts.join("") },
        ],
        max_tokens: MAX_OUTPUT_TOKENS,
        stream: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`DeepSeek 请求超过 ${TIMEOUT_MS}ms 超时。可拆分任务或调高 DEEPSEEK_TIMEOUT_MS。`);
    }
    throw err;
  }

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`DeepSeek API 返回 ${res.status}: ${raw.slice(0, 500)}`);
  }

  let parsed: {
    model?: string;
    choices?: {
      finish_reason?: string;
      message?: { content?: string; reasoning_content?: string };
    }[];
    usage?: DeepSeekResult["usage"];
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`DeepSeek 返回了非 JSON 内容: ${raw.slice(0, 200)}`);
  }

  const choice = parsed?.choices?.[0];
  const text = choice?.message?.content;
  if (typeof text !== "string") {
    throw new Error(`DeepSeek 响应结构不符合预期: ${raw.slice(0, 300)}`);
  }

  return {
    text,
    model: parsed?.model ?? MODEL,
    usage: parsed?.usage,
    finishReason: choice?.finish_reason,
  };
}

function toResult({ text, model, usage }: Attempt): DeepSeekResult {
  return { text, model, usage };
}

/**
 * deepseek-flash returns `reasoning_content` alongside the answer, and sometimes
 * emits reasoning *only*: `content` comes back as an empty string, either
 * because reasoning consumed the whole max_tokens budget (finish_reason
 * "length") or because the model just stopped without writing anything
 * (finish_reason "stop" — measured at roughly 1 call in 10). Both would reach
 * Sol as a successful-looking but empty reply. It's transient, so one retry.
 */
export async function callDeepSeek(req: DeepSeekRequest): Promise<DeepSeekResult> {
  const first = await attempt(req);
  if (first.text.trim() !== "") return toResult(first);

  const second = await attempt(req);
  if (second.text.trim() !== "") return toResult(second);

  const reason =
    second.finishReason === "length"
      ? `推理过程占满了 max_tokens(${MAX_OUTPUT_TOKENS})`
      : `模型只产出推理内容就结束了(finish_reason=${second.finishReason ?? "?"})`;
  throw new Error(
    `DeepSeek 连续两次没有返回正文:${reason}。可调高 DEEPSEEK_MAX_OUTPUT_TOKENS,或把任务拆小。`,
  );
}
