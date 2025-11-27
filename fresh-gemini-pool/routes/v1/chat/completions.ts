import { Handlers } from "$fresh/server.ts";
import { AccountManager } from "../../../lib/account-manager.ts";
import { ensureJWT } from "../../../lib/jwt-manager.ts";
import { ensureSession } from "../../../lib/session-manager.ts";
import { streamChat } from "../../../lib/gemini-api.ts";
import type { ChatCompletionRequest, ChatMessage } from "../../../lib/types.ts";

/**
 * OpenAI 兼容的聊天完成接口
 * POST /v1/chat/completions
 */
export const handler: Handlers = {
  async POST(req, _ctx) {
    const kv = await Deno.openKv();
    const manager = new AccountManager(kv);

    try {
      const body: ChatCompletionRequest = await req.json();
      const { messages, stream = false, model = "gemini-enterprise" } = body;

      if (!messages || messages.length === 0) {
        return Response.json({ error: "No messages provided" }, { status: 400 });
      }

      // 获取代理配置
      const proxyRes = await kv.get<string>(["config", "proxy"]);
      const proxy = proxyRes.value || undefined;

      // 多账号重试逻辑
      const maxRetries = 3;
      let lastError: Error | null = null;

      for (let i = 0; i < maxRetries; i++) {
        try {
          // 轮训获取账号
          const account = await manager.getNextAccountAtomic();
          console.log(`[Attempt ${i + 1}] Using account:`, account.id);

          // 确保 JWT 和会话
          const jwt = await ensureJWT(kv, account);
          const session = await ensureSession(kv, account, jwt);

          // 调用 Gemini API
          const result = await streamChat({
            jwt,
            session,
            messages,
            teamId: account.team_id,
            proxy,
          });

          // 成功获取响应
          if (stream) {
            return createStreamResponse(result.text, model, messages);
          } else {
            return createNonStreamResponse(result.text, model, messages);
          }
        } catch (error) {
          lastError = error as Error;
          console.error(`[Attempt ${i + 1}] Failed:`, error);

          // 如果是 401/404 错误，标记账号不可用
          if (error.message.includes("401") || error.message.includes("404")) {
            const account = await manager.getNextAccountAtomic();
            await manager.markUnavailable(account.id, error.message);
          }

          // 继续重试下一个账号
          continue;
        }
      }

      // 所有账号都失败
      return Response.json(
        { error: `All accounts failed: ${lastError?.message}` },
        { status: 500 }
      );
    } catch (error) {
      console.error("Request processing error:", error);
      return Response.json(
        { error: error instanceof Error ? error.message : "Unknown error" },
        { status: 500 }
      );
    }
  },
};

/**
 * 创建流式响应
 */
function createStreamResponse(text: string, model: string, messages: ChatMessage[]): Response {
  const encoder = new TextEncoder();
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  const stream = new ReadableStream({
    start(controller) {
      try {
        // 将文本分块发送（模拟流式）
        const words = text.split(" ");
        let currentChunk = "";

        for (let i = 0; i < words.length; i++) {
          currentChunk = words[i] + (i < words.length - 1 ? " " : "");

          const chunk = {
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {
                  content: currentChunk,
                },
                finish_reason: null,
              },
            ],
          };

          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }

        // 发送结束标记
        const finalChunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        };

        controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

/**
 * 创建非流式响应
 */
function createNonStreamResponse(text: string, model: string, messages: ChatMessage[]): Response {
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  // 估算 token 数量（简单估计：每4个字符约1个token）
  const estimateTokens = (str: string) => Math.ceil(str.length / 4);

  const promptTokens = messages.reduce((sum, msg) => {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    return sum + estimateTokens(content);
  }, 0);

  const completionTokens = estimateTokens(text);

  return Response.json({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
}
