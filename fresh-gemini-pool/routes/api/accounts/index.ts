import { Handlers } from "$fresh/server.ts";
import { AccountManager } from "../../../lib/account-manager.ts";
import type { Account } from "../../../lib/types.ts";

/**
 * 账号管理 API
 * GET /api/accounts - 列出所有账号
 * POST /api/accounts - 创建新账号
 */
export const handler: Handlers = {
  // 列出所有账号
  async GET(_req, _ctx) {
    const kv = await Deno.openKv();
    const manager = new AccountManager(kv);

    try {
      const accounts = await manager.listAccounts();
      const stats = await manager.getAccountStats();

      return Response.json({
        accounts,
        current_index: stats.currentIndex,
        stats: {
          total: stats.total,
          available: stats.available,
          unavailable: stats.unavailable,
        },
      });
    } catch (error) {
      console.error("Failed to list accounts:", error);
      return Response.json({ error: "Failed to list accounts" }, { status: 500 });
    }
  },

  // 创建新账号
  async POST(req, _ctx) {
    const kv = await Deno.openKv();
    const manager = new AccountManager(kv);

    try {
      const data = await req.json();

      // 验证必需字段
      if (!data.team_id || !data.secure_c_ses || !data.csesidx) {
        return Response.json(
          { error: "Missing required fields: team_id, secure_c_ses, csesidx" },
          { status: 400 }
        );
      }

      const newAccount = await manager.createAccount({
        team_id: data.team_id,
        secure_c_ses: data.secure_c_ses,
        host_c_oses: data.host_c_oses || "",
        csesidx: data.csesidx,
        user_agent: data.user_agent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        available: true,
      });

      return Response.json({
        success: true,
        account: newAccount,
      });
    } catch (error) {
      console.error("Failed to create account:", error);
      return Response.json(
        { error: error instanceof Error ? error.message : "Failed to create account" },
        { status: 500 }
      );
    }
  },
};
