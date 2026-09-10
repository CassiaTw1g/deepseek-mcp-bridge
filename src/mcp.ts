import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { callDeepSeek, MODES } from "./deepseek.ts";

/**
 * This description is the router. It is the only thing Sol reads when deciding
 * whether to spend a tool call on DeepSeek, so it states the *dispatch
 * conditions* rather than what the tool technically does.
 */
export const TOOL_DESCRIPTION = [
  "调用外部模型 DeepSeek V4.1 Flash 执行任务。DeepSeek 与 OpenAI 模型无关,独立推理,因此它的判断不共享本会话模型的同源偏置。",
  "",
  "适用场景:",
  "(1) 需要跨厂商独立复核的任务——安全审查、逻辑反例构造、对某个结论的对抗性验证。把实现或原始材料传进去,但不要传你自己的结论,否则独立性会被污染。",
  "(2) 大批量、低风险的机械性工作:摘要、分类、格式转换、批量文本处理。",
  "(3) 超长材料(约 1M token)的检索与归纳。",
  "",
  "不适用(请改用 Luna 子代理):需要读写本地文件、需要多轮工具交互、或需要与其他子代理并行协作的任务。",
  "",
  "本工具无法访问文件系统,所有材料必须以文本形式通过 files 参数传入。",
].join("\n");

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "deepseek-bridge", version: "1.0.0" });

  server.registerTool(
    "deepseek_flash",
    {
      title: "DeepSeek V4.1 Flash 外部复核",
      description: TOOL_DESCRIPTION,
      inputSchema: {
        task: z
          .string()
          .min(1)
          .describe(
            "要 DeepSeek 完成的具体任务。写清目标、约束、期望的输出格式。独立复核场景下不要在此透露你自己的结论。",
          ),
        mode: z
          .enum(MODES)
          .optional()
          .describe(
            "任务类型,决定系统提示词。analyze=独立分析并给结论;review=对抗性审查/找缺陷与反例;code=产出代码;summarize=归纳要点。默认 analyze。",
          ),
        files: z
          .string()
          .optional()
          .describe(
            "要分析或审查的代码/文本材料,纯文本透传。DeepSeek 无法访问你的文件系统,内容必须贴在这里。",
          ),
      },
    },
    async ({ task, mode, files }) => {
      try {
        const result = await callDeepSeek({ task, mode: mode ?? "analyze", files });
        const { prompt_tokens, completion_tokens } = result.usage ?? {};
        const footer =
          prompt_tokens != null || completion_tokens != null
            ? `\n\n[deepseek: ${result.model} | ${prompt_tokens ?? "?"} in / ${completion_tokens ?? "?"} out]`
            : "";
        return { content: [{ type: "text" as const, text: result.text + footer }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("deepseek_flash failed:", message);
        return {
          content: [{ type: "text" as const, text: `DeepSeek 调用失败:${message}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}
