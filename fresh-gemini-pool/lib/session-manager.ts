import type { Account, SessionCache } from "./types.ts";

const CREATE_SESSION_URL = "https://biz-discoveryengine.googleapis.com/v1alpha/locations/global/widgetCreateSession";

/**
 * 获取请求头
 */
function getHeaders(jwt: string): HeadersInit {
  return {
    accept: "*/*",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
    authorization: `Bearer ${jwt}`,
    "content-type": "application/json",
    origin: "https://business.gemini.google",
    referer: "https://business.gemini.google/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Chromium";v="140", "Not=A?Brand";v="24", "Microsoft Edge";v="140"',
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
    "x-server-timeout": "1800",
  };
}

/**
 * 去除 XSSI 前缀
 */
function stripXssi(text: string): string {
  const prefix = ")]}'";
  return text.startsWith(prefix) ? text.slice(prefix.length).trimStart() : text;
}

/**
 * 创建聊天会话
 */
async function createChatSession(jwt: string, teamId: string, proxy?: string): Promise<string> {
  const sessionId = crypto.randomUUID().slice(0, 12);
  const body = {
    configId: teamId,
    additionalParams: { token: "-" },
    createSessionRequest: {
      session: { name: sessionId, displayName: sessionId },
    },
  };

  const fetchOptions: RequestInit = {
    method: "POST",
    headers: getHeaders(jwt),
    body: JSON.stringify(body),
  };

  // 如果有代理配置，使用代理
  if (proxy) {
    try {
      const proxyClient = Deno.createHttpClient({ proxy: { url: proxy } });
      (fetchOptions as any).client = proxyClient;
    } catch (e) {
      console.warn("Failed to create proxy client:", e);
    }
  }

  const res = await fetch(CREATE_SESSION_URL, fetchOptions);
  const text = await res.text();

  if (!res.ok) {
    console.error("Create session failed:", res.status, text.slice(0, 200));
    throw new Error(`Create session failed: ${res.status}`);
  }

  try {
    const data = JSON.parse(stripXssi(text));
    if (!data.session?.name) {
      throw new Error("Session name not returned");
    }
    return data.session.name;
  } catch (err) {
    console.error("Parse session response error:", text.slice(0, 200), err);
    throw err;
  }
}

/**
 * 确保会话可用（带缓存）
 */
export async function ensureSession(kv: Deno.Kv, account: Account, jwt: string): Promise<string> {
  const cacheKey = ["session_cache", account.id];

  // 检查缓存（会话有效期较长，可以缓存更久）
  const cached = await kv.get<SessionCache>(cacheKey);
  if (cached.value && (Date.now() - cached.value.created_at) < 3600000) { // 1小时
    return cached.value.session_id;
  }

  // 获取代理配置
  const proxyRes = await kv.get<string>(["config", "proxy"]);
  const proxy = proxyRes.value;

  // 创建新会话
  const sessionId = await createChatSession(jwt, account.team_id, proxy || undefined);

  // 缓存会话
  await kv.set(
    cacheKey,
    {
      session_id: sessionId,
      created_at: Date.now(),
    } as SessionCache,
    { expireIn: 3600000 } // 1小时
  );

  return sessionId;
}

/**
 * 清除账号的会话缓存
 */
export async function clearSessionCache(kv: Deno.Kv, accountId: string): Promise<void> {
  await kv.delete(["session_cache", accountId]);
}
