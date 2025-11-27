import { Handlers } from "$fresh/server.ts";
import { AccountManager } from "../../lib/account-manager.ts";

/**
 * 系统状态 API
 * GET /api/status
 */
export const handler: Handlers = {
  async GET(_req, _ctx) {
    const kv = await Deno.openKv();
    const manager = new AccountManager(kv);

    try {
      const stats = await manager.getAccountStats();

      return Response.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        accounts: stats,
      });
    } catch (error) {
      console.error("Failed to get status:", error);
      return Response.json(
        {
          status: "error",
          error: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 500 }
      );
    }
  },
};
