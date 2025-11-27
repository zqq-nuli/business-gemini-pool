import { Handlers } from "$fresh/server.ts";
import { ConfigStore } from "../../../lib/config-store.ts";
import type { Model } from "../../../lib/types.ts";

/**
 * 模型管理 API
 * GET /api/models - 列出所有模型
 * POST /api/models - 创建新模型
 */
export const handler: Handlers = {
  // 列出所有模型
  async GET(_req, _ctx) {
    const kv = await Deno.openKv();
    const store = new ConfigStore(kv);

    try {
      const models = await store.listModels();
      return Response.json({ models });
    } catch (error) {
      console.error("Failed to list models:", error);
      return Response.json({ error: "Failed to list models" }, { status: 500 });
    }
  },

  // 创建新模型
  async POST(req, _ctx) {
    const kv = await Deno.openKv();
    const store = new ConfigStore(kv);

    try {
      const data: Model = await req.json();

      // 验证必需字段
      if (!data.id || !data.name) {
        return Response.json(
          { error: "Missing required fields: id, name" },
          { status: 400 }
        );
      }

      // 检查模型是否已存在
      const existing = await store.getModel(data.id);
      if (existing) {
        return Response.json({ error: "Model already exists" }, { status: 409 });
      }

      await store.createModel({
        id: data.id,
        name: data.name,
        description: data.description || "",
        context_length: data.context_length || 1000000,
        max_tokens: data.max_tokens || 8192,
        is_public: data.is_public ?? true,
        enabled: data.enabled ?? true,
      });

      return Response.json({ success: true });
    } catch (error) {
      console.error("Failed to create model:", error);
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to create model" },
        { status: 500 }
      );
    }
  },
};
