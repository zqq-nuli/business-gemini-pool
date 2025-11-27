import { Handlers } from "$fresh/server.ts";
import { AccountManager } from "../../../../lib/account-manager.ts";

/**
 * 单个账号管理 API
 * GET /api/accounts/:id - 获取账号详情
 * PUT /api/accounts/:id - 更新账号
 * DELETE /api/accounts/:id - 删除账号
 */
export const handler: Handlers = {
  // 获取账号详情
  async GET(_req, ctx) {
    const kv = await Deno.openKv();
    const manager = new AccountManager(kv);
    const { id } = ctx.params;

    try {
      const account = await manager.getAccount(id);
      if (!account) {
        return Response.json({ error: "Account not found" }, { status: 404 });
      }

      return Response.json({ account });
    } catch (error) {
      console.error("Failed to get account:", error);
      return Response.json({ error: "Failed to get account" }, { status: 500 });
    }
  },

  // 更新账号
  async PUT(req, ctx) {
    const kv = await Deno.openKv();
    const manager = new AccountManager(kv);
    const { id } = ctx.params;

    try {
      const data = await req.json();
      const success = await manager.updateAccount(id, data);

      if (!success) {
        return Response.json({ error: "Account not found" }, { status: 404 });
      }

      const account = await manager.getAccount(id);
      return Response.json({
        success: true,
        account,
      });
    } catch (error) {
      console.error("Failed to update account:", error);
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to update account" },
        { status: 500 }
      );
    }
  },

  // 删除账号
  async DELETE(_req, ctx) {
    const kv = await Deno.openKv();
    const manager = new AccountManager(kv);
    const { id } = ctx.params;

    try {
      const success = await manager.deleteAccount(id);

      if (!success) {
        return Response.json({ error: "Account not found" }, { status: 404 });
      }

      return Response.json({ success: true });
    } catch (error) {
      console.error("Failed to delete account:", error);
      return Response.json({ error: "Failed to delete account" }, { status: 500 });
    }
  },
};
