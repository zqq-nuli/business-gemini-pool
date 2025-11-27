import type { Account, JWTCache } from "./types.ts";

const GETOXSRF_URL = "https://business.gemini.google/auth/getoxsrf";

/**
 * 将 Base64 URL 编码的字符串转换为字节数组
 */
function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (c) => c.charCodeAt(0));
}

/**
 * URL 安全的 Base64 编码
 */
function urlSafeBase64Encode(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let base64 = "";
  const uint8 = new Uint8Array(bytes);

  const CHUNK_SIZE = 0x8000;
  for (let i = 0; i < uint8.length; i += CHUNK_SIZE) {
    const chunk = uint8.subarray(i, i + CHUNK_SIZE);
    base64 += String.fromCharCode.apply(null, Array.from(chunk));
  }

  const encoded = btoa(base64);
  return encoded.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * 模拟 Python 版的 kq_encode（处理 >255 的字符）
 */
function kqEncode(str: string): string {
  const byteArr: number[] = [];
  for (const ch of str) {
    const val = ch.charCodeAt(0);
    if (val > 255) {
      byteArr.push(val & 255);
      byteArr.push(val >> 8);
    } else {
      byteArr.push(val);
    }
  }
  return urlSafeBase64Encode(new Uint8Array(byteArr));
}

/**
 * 创建 JWT token
 */
async function createJwt(keyBytes: Uint8Array, keyId: string, csesidx: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "HS256",
    typ: "JWT",
    kid: keyId,
  };

  const payload = {
    iss: "https://business.gemini.google",
    aud: "https://biz-discoveryengine.googleapis.com",
    sub: `csesidx/${csesidx}`,
    iat: now,
    exp: now + 300,
    nbf: now,
  };

  const headerB64 = kqEncode(JSON.stringify(header));
  const payloadB64 = kqEncode(JSON.stringify(payload));
  const message = `${headerB64}.${payloadB64}`;

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  const signatureB64 = urlSafeBase64Encode(new Uint8Array(signature));

  return `${message}.${signatureB64}`;
}

/**
 * 去除 XSSI 前缀
 */
function stripXssi(text: string): string {
  const prefix = ")]}'";
  return text.startsWith(prefix) ? text.slice(prefix.length).trimStart() : text;
}

/**
 * 获取代理配置
 */
async function getProxyConfig(kv: Deno.Kv): Promise<string | null> {
  const res = await kv.get<string>(["config", "proxy"]);
  return res.value;
}

/**
 * 从 Gemini 获取 JWT token
 */
async function getJWTForAccount(account: Account, proxy?: string): Promise<string> {
  const { secure_c_ses, host_c_oses, csesidx, user_agent } = account;

  const cookieStr = `__Secure-C_SES=${secure_c_ses}${host_c_oses ? `; __Host-C_OSES=${host_c_oses}` : ""}`;
  const url = `${GETOXSRF_URL}?csesidx=${csesidx}`;

  const fetchOptions: RequestInit = {
    headers: {
      accept: "*/*",
      "user-agent": user_agent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      cookie: cookieStr,
    },
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

  const res = await fetch(url, fetchOptions);

  if (!res.ok) {
    throw new Error(`JWT fetch failed: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();
  const stripped = stripXssi(text);
  const data = JSON.parse(stripped);

  if (!data.xsrfToken) {
    throw new Error("xsrfToken not returned");
  }

  const keyBytes = base64UrlToBytes(data.xsrfToken);
  return await createJwt(keyBytes, data.keyId, csesidx);
}

/**
 * 确保 JWT 可用（带缓存）
 * 缓存时间为 240 秒，实际有效期为 300 秒
 */
export async function ensureJWT(kv: Deno.Kv, account: Account): Promise<string> {
  const cacheKey = ["jwt_cache", account.id];

  // 检查缓存
  const cached = await kv.get<JWTCache>(cacheKey);
  if (cached.value && cached.value.expires_at > Date.now()) {
    return cached.value.jwt;
  }

  // 获取代理配置
  const proxy = await getProxyConfig(kv);

  // 获取新 JWT
  const jwt = await getJWTForAccount(account, proxy || undefined);

  // 缓存 240 秒
  await kv.set(
    cacheKey,
    {
      jwt,
      expires_at: Date.now() + 240000,
    } as JWTCache,
    { expireIn: 240000 }
  );

  return jwt;
}

/**
 * 清除账号的 JWT 缓存
 */
export async function clearJWTCache(kv: Deno.Kv, accountId: string): Promise<void> {
  await kv.delete(["jwt_cache", accountId]);
}
