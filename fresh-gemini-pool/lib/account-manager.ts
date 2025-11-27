import type { Account } from "./types.ts";

export class AccountManager {
  private kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this.kv = kv;
  }

  /**
   * 列出所有账号
   */
  async listAccounts(): Promise<Account[]> {
    const entries = this.kv.list<Account>({ prefix: ["accounts"] });
    const accounts: Account[] = [];
    for await (const entry of entries) {
      accounts.push(entry.value);
    }
    return accounts.sort((a, b) => a.created_at - b.created_at);
  }

  /**
   * 获取单个账号
   */
  async getAccount(id: string): Promise<Account | null> {
    const res = await this.kv.get<Account>(["accounts", id]);
    return res.value;
  }

  /**
   * 创建账号
   */
  async createAccount(data: Omit<Account, "id" | "created_at">): Promise<Account> {
    const account: Account = {
      ...data,
      id: crypto.randomUUID(),
      created_at: Date.now(),
    };
    await this.kv.set(["accounts", account.id], account);
    return account;
  }

  /**
   * 更新账号
   */
  async updateAccount(id: string, data: Partial<Account>): Promise<boolean> {
    const existing = await this.getAccount(id);
    if (!existing) return false;

    const updated = { ...existing, ...data };
    await this.kv.set(["accounts", id], updated);
    return true;
  }

  /**
   * 删除账号
   */
  async deleteAccount(id: string): Promise<boolean> {
    const existing = await this.getAccount(id);
    if (!existing) return false;

    await this.kv.delete(["accounts", id]);
    // 清理关联缓存
    await this.kv.delete(["jwt_cache", id]);
    await this.kv.delete(["session_cache", id]);
    return true;
  }

  /**
   * 获取所有可用账号
   */
  async getAvailableAccounts(): Promise<Account[]> {
    const all = await this.listAccounts();
    return all.filter((a) => a.available);
  }

  /**
   * 原子性获取下一个账号（轮训调度）
   * 使用乐观锁避免并发冲突
   */
  async getNextAccountAtomic(): Promise<Account> {
    const available = await this.getAvailableAccounts();
    if (available.length === 0) {
      throw new Error("No available accounts");
    }

    const indexKey = ["state", "current_index"];
    let success = false;
    let selectedAccount: Account | undefined;

    // 重试最多 10 次
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await this.kv.get<number>(indexKey);
      const currentIndex = res.value ?? 0;
      const normalizedIndex = currentIndex % available.length;
      const nextIndex = (currentIndex + 1) % available.length;

      const commitResult = await this.kv.atomic()
        .check(res) // 乐观锁：确保版本号未变
        .set(indexKey, nextIndex)
        .commit();

      if (commitResult.ok) {
        selectedAccount = available[normalizedIndex];
        success = true;
        break;
      }

      // 短暂延迟后重试
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    if (!success || !selectedAccount) {
      throw new Error("Failed to acquire account after retries");
    }

    return selectedAccount;
  }

  /**
   * 标记账号为不可用
   */
  async markUnavailable(id: string, reason: string): Promise<void> {
    const account = await this.getAccount(id);
    if (!account) return;

    await this.kv.set(["accounts", id], {
      ...account,
      available: false,
      unavailable_reason: reason,
      unavailable_time: new Date().toISOString(),
    });
  }

  /**
   * 标记账号为可用
   */
  async markAvailable(id: string): Promise<void> {
    const account = await this.getAccount(id);
    if (!account) return;

    await this.kv.set(["accounts", id], {
      ...account,
      available: true,
      unavailable_reason: undefined,
      unavailable_time: undefined,
    });
  }

  /**
   * 切换账号可用状态
   */
  async toggleAvailability(id: string): Promise<boolean> {
    const account = await this.getAccount(id);
    if (!account) return false;

    const newAvailable = !account.available;
    await this.kv.set(["accounts", id], {
      ...account,
      available: newAvailable,
      unavailable_reason: newAvailable ? undefined : account.unavailable_reason,
      unavailable_time: newAvailable ? undefined : account.unavailable_time,
    });

    return newAvailable;
  }

  /**
   * 获取账号统计信息
   */
  async getAccountStats(): Promise<{ total: number; available: number; unavailable: number; currentIndex: number }> {
    const all = await this.listAccounts();
    const available = all.filter((a) => a.available);
    const indexRes = await this.kv.get<number>(["state", "current_index"]);

    return {
      total: all.length,
      available: available.length,
      unavailable: all.length - available.length,
      currentIndex: indexRes.value ?? 0,
    };
  }
}
