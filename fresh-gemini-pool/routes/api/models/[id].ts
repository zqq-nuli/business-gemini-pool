import { Handlers } from "$fresh/server.ts";
import { ConfigStore } from "../../../lib/config-store.ts";

/**
 * 单个模型管理 API
 * GET /api/models/:id - 获取模型详情
 * PUT /api/models/:id - 更新模型
 * DELETE /api/models/:id - 删除模型
 */
export const handler: Handlers = {
  // 获取模型详情
  async GET(_req, ctx) {
    const kv = await Deno.openKv();
    const store = new ConfigStore(kv);
    const { id } = ctx.params;

    try {
      const model = await store.getModel(id);
      if (!model) {
        return Response.json({ error: "Model not found" }, { status: 404 });
      }

      return Response.json({ model });
    } catch (error) {
      console.error("Failed to get model:", error);
      return Response.json({ error: "Failed to get model" }, { status: 500 });
    }
  },

  // 更新模型
  async PUT(req, ctx) {
    const kv = await Deno.openKv();
    const store = new ConfigStore(kv);
    const { id } = ctx.params;

    try {
      const data = await req.json();
      const success = await store.updateModel(id, data);

      if (!success) {
        return Response.json({ error: "Model not found" }, { status: 404 });
      }

      const model = await store.getModel(id);
      return Response.json({
        success: true,
        model,
      });
    } catch (error) {
      console.error("Failed to update model:", error);
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to update model" },
        { status: 500 }
      );
    }
  },

  // 删除模型
  async DELETE(_req, ctx) {
    const kv = await Deno.openKv();
    const store = new ConfigStore(kv);
    const { id } = ctx.params;

    try {
      const success = await store.deleteModel(id);

      if (!success) {
        return Response.json({ error: "Model not found" }, { status: 404 });
      }

      return Response.json({ success: true });
    } catch (error) {
      console.error("Failed to delete model:", error);
      return Response.json({ error: "Failed to delete model" }, { status: 500 });
    }
  },
};
