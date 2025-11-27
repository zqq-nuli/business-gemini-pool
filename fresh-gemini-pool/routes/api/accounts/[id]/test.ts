import { Handlers } from "$fresh/server.ts";
import { AccountManager } from "../../../../lib/account-manager.ts";
import { ensureJWT } from "../../../../lib/jwt-manager.ts";
import { ensureSession } from "../../../../lib/session-manager.ts";

/**
 * 测试账号连接
 * POST /api/accounts/:id/test
 */
export const handler: Handlers = {
  async POST(_req, ctx) {
    const kv = await Deno.openKv();
    const manager = new AccountManager(kv);
    const { id } = ctx.params;

    try {
      const account = await manager.getAccount(id);
      if (!account) {
        return Response.json({ error: "Account not found" }, { status: 404 });
      }

      // 尝试获取 JWT
      const jwt = await ensureJWT(kv, account);

      // 尝试创建/获取会话
      const session = await ensureSession(kv, account, jwt);

      // 标记为可用
      await manager.markAvailable(id);

      return Response.json({
        success: true,
        message: "Account test successful",
        jwt: jwt.substring(0, 20) + "...",
        session: session,
      });
    } catch (error) {
      console.error("Account test failed:", error);

      // 标记为不可用
      await manager.markUnavailable(id, error instanceof Error ? error.message : "Unknown error");

      return Response.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 500 }
      );
    }
  },
};
