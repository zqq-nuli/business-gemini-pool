import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";

interface Account {
  id: string;
  team_id: string;
  csesidx: string;
  user_agent: string;
  available: boolean;
  unavailable_reason?: string;
}

interface Stats {
  total: number;
  available: number;
  unavailable: number;
  currentIndex: number;
}

const accounts = signal<Account[]>([]);
const stats = signal<Stats>({ total: 0, available: 0, unavailable: 0, currentIndex: 0 });
const loading = signal(false);
const showAddModal = signal(false);

export default function AccountManager() {
  useEffect(() => {
    loadAccounts();
  }, []);

  async function loadAccounts() {
    loading.value = true;
    try {
      const res = await fetch("/api/accounts");
      const data = await res.json();
      accounts.value = data.accounts || [];
      stats.value = data.stats || {};
    } catch (error) {
      console.error("Failed to load accounts:", error);
    } finally {
      loading.value = false;
    }
  }

  async function deleteAccount(id: string) {
    if (!confirm("确定要删除这个账号吗？")) return;

    try {
      const res = await fetch(`/api/accounts/${id}`, { method: "DELETE" });
      if (res.ok) {
        await loadAccounts();
        alert("删除成功");
      }
    } catch (error) {
      console.error("Failed to delete:", error);
      alert("删除失败");
    }
  }

  async function toggleAccount(id: string) {
    try {
      const res = await fetch(`/api/accounts/${id}/toggle`, { method: "POST" });
      if (res.ok) {
        await loadAccounts();
      }
    } catch (error) {
      console.error("Failed to toggle:", error);
    }
  }

  async function testAccount(id: string) {
    try {
      const res = await fetch(`/api/accounts/${id}/test`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        alert("测试成功！");
        await loadAccounts();
      } else {
        alert(`测试失败: ${data.error}`);
      }
    } catch (error) {
      console.error("Failed to test:", error);
      alert("测试失败");
    }
  }

  async function addAccount(event: Event) {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const formData = new FormData(form);

    const account = {
      team_id: formData.get("team_id"),
      secure_c_ses: formData.get("secure_c_ses"),
      host_c_oses: formData.get("host_c_oses"),
      csesidx: formData.get("csesidx"),
      user_agent: formData.get("user_agent"),
    };

    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(account),
      });

      if (res.ok) {
        showAddModal.value = false;
        form.reset();
        await loadAccounts();
        alert("添加成功");
      } else {
        const error = await res.json();
        alert(`添加失败: ${error.error}`);
      }
    } catch (error) {
      console.error("Failed to add:", error);
      alert("添加失败");
    }
  }

  return (
    <div class="px-4 py-6">
      {/* 统计卡片 */}
      <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div class="bg-white p-6 rounded-lg shadow">
          <div class="text-sm text-gray-500">总账号数</div>
          <div class="text-3xl font-bold mt-2">{stats.value.total}</div>
        </div>
        <div class="bg-white p-6 rounded-lg shadow">
          <div class="text-sm text-gray-500">可用账号</div>
          <div class="text-3xl font-bold text-green-600 mt-2">{stats.value.available}</div>
        </div>
        <div class="bg-white p-6 rounded-lg shadow">
          <div class="text-sm text-gray-500">不可用账号</div>
          <div class="text-3xl font-bold text-red-600 mt-2">{stats.value.unavailable}</div>
        </div>
        <div class="bg-white p-6 rounded-lg shadow">
          <div class="text-sm text-gray-500">当前轮训索引</div>
          <div class="text-3xl font-bold text-blue-600 mt-2">{stats.value.currentIndex}</div>
        </div>
      </div>

      {/* 账号列表 */}
      <div class="bg-white rounded-lg shadow">
        <div class="p-6 border-b border-gray-200 flex justify-between items-center">
          <h2 class="text-lg font-semibold">账号列表</h2>
          <button
            onClick={() => (showAddModal.value = true)}
            class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
          >
            添加账号
          </button>
        </div>

        <div class="overflow-x-auto">
          <table class="min-w-full divide-y divide-gray-200">
            <thead class="bg-gray-50">
              <tr>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">序号</th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Team ID</th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">CSESIDX</th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">状态</th>
                <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">操作</th>
              </tr>
            </thead>
            <tbody class="bg-white divide-y divide-gray-200">
              {accounts.value.length === 0 ? (
                <tr>
                  <td colSpan={5} class="px-6 py-12 text-center text-gray-500">
                    暂无账号，请点击"添加账号"按钮创建
                  </td>
                </tr>
              ) : (
                accounts.value.map((acc, index) => (
                  <tr key={acc.id}>
                    <td class="px-6 py-4 whitespace-nowrap text-sm">{index + 1}</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm font-mono">{acc.team_id.slice(0, 20)}...</td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm font-mono">{acc.csesidx}</td>
                    <td class="px-6 py-4 whitespace-nowrap">
                      <span
                        class={`px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${
                          acc.available ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
                        }`}
                      >
                        {acc.available ? "可用" : "不可用"}
                      </span>
                      {acc.unavailable_reason && (
                        <span class="ml-2 text-xs text-gray-500">{acc.unavailable_reason}</span>
                      )}
                    </td>
                    <td class="px-6 py-4 whitespace-nowrap text-sm space-x-2">
                      <button
                        onClick={() => toggleAccount(acc.id)}
                        class={`px-3 py-1 rounded ${
                          acc.available ? "bg-yellow-100 text-yellow-800" : "bg-green-100 text-green-800"
                        }`}
                      >
                        {acc.available ? "禁用" : "启用"}
                      </button>
                      <button
                        onClick={() => testAccount(acc.id)}
                        class="px-3 py-1 bg-blue-100 text-blue-800 rounded"
                      >
                        测试
                      </button>
                      <button
                        onClick={() => deleteAccount(acc.id)}
                        class="px-3 py-1 bg-red-100 text-red-800 rounded"
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 添加账号模态框 */}
      {showAddModal.value && (
        <div class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div class="bg-white rounded-lg p-6 max-w-md w-full mx-4">
            <h3 class="text-lg font-semibold mb-4">添加账号</h3>
            <form onSubmit={addAccount}>
              <div class="space-y-4">
                <div>
                  <label class="block text-sm font-medium text-gray-700">Team ID</label>
                  <input
                    type="text"
                    name="team_id"
                    required
                    class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md"
                  />
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700">Secure C SES</label>
                  <textarea
                    name="secure_c_ses"
                    required
                    rows={3}
                    class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md"
                  />
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700">Host C OSES (可选)</label>
                  <textarea
                    name="host_c_oses"
                    rows={2}
                    class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md"
                  />
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700">CSESIDX</label>
                  <input
                    type="text"
                    name="csesidx"
                    required
                    class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md"
                  />
                </div>
                <div>
                  <label class="block text-sm font-medium text-gray-700">User Agent (可选)</label>
                  <input
                    type="text"
                    name="user_agent"
                    class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md"
                    placeholder="Mozilla/5.0..."
                  />
                </div>
              </div>
              <div class="mt-6 flex justify-end space-x-3">
                <button
                  type="button"
                  onClick={() => (showAddModal.value = false)}
                  class="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
                >
                  取消
                </button>
                <button
                  type="submit"
                  class="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
                >
                  保存
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
