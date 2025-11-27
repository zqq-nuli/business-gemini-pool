// Usage:
// 1) 配置 .env（优先使用 BIZ_* 别名）
//    - BIZ_GEMINI_SECURE_C_SES / SECURE_C_SES
//    - BIZ_GEMINI_HOST_C_OSES   / HOST_C_OSES
//    - BIZ_GEMINI_CSESIDX       / CSESIDX
//    - BIZ_GEMINI_GROUP_ID      / CONFIG_ID
//    - 可选: MODEL_NAME, BIZ_GEMINI_PROXY/PROXY_SERVER, PORT
// 2) 本地启动: pnpx deno run --allow-net --allow-env --allow-read --allow-write gemini.ts
// 3) 端点:
//    - POST /v1/chat/completions  (OpenAI 兼容, 支持 stream/stream_options.include_usage)
//    - GET  /v1/models
//    - POST /api/chat             (简单页面示例)
// 说明:
//    - 流响应为“伪流”，先拿到完整回复后按块推送 SSE，便于与 ChatGPT 客户端兼容。
//    - createSession/streamAssist 内置 401 刷新 JWT、404 重建 session 重试。

// 导入标准库
import { config } from "https://deno.land/x/dotenv/mod.ts";
import { encodeBase64 } from "https://deno.land/std/encoding/base64.ts";
import { join } from "https://deno.land/std/path/mod.ts";

// 配置项
const IS_DEPLOY = Boolean(Deno.env.get("DENO_DEPLOYMENT_ID"));
if (!IS_DEPLOY) {
  config({ export: true });
}

// 调试打印当前环境变量，便于确认配置是否正确（生产环境慎用）
console.log("ENV SECURE_C_SES:", Deno.env.get("SECURE_C_SES") ?? "undefined");
console.log("ENV HOST_C_OSES:", Deno.env.get("HOST_C_OSES") ?? "undefined");
console.log("ENV CSESIDX:", Deno.env.get("CSESIDX") ?? "undefined");

const CONFIG_FILE = join(Deno.cwd(), "business_gemini_session.json");
const PROXY_SERVER = Deno.env.get("BIZ_GEMINI_PROXY") ?? Deno.env.get("PROXY_SERVER") ?? "http://127.0.0.1:7890";
const CONFIG_ID = Deno.env.get("BIZ_GEMINI_GROUP_ID") ?? Deno.env.get("CONFIG_ID") ?? "4b5c35b9-12f0-4235-b93c-5f745ebb88a1";
const MODEL_NAME = Deno.env.get("MODEL_NAME") ?? "gemini-business";

// API 接口
const BASE_URL = "https://biz-discoveryengine.googleapis.com/v1alpha/locations/global";
const CREATE_SESSION_URL = `${BASE_URL}/widgetCreateSession`;
const STREAM_ASSIST_URL = `${BASE_URL}/widgetStreamAssist`;
const GETOXSRF_URL = "https://business.gemini.google/auth/getoxsrf";
const LIST_FILE_METADATA_URL = `${BASE_URL}/widgetListSessionFileMetadata`;
const DOWNLOAD_FILE_BASE = "https://biz-discoveryengine.googleapis.com/v1alpha";
const IMAGE_SAVE_DIR = join(Deno.cwd(), "biz_gemini_images");

const proxyClient = !IS_DEPLOY && PROXY_SERVER
  ? Deno.createHttpClient({ proxy: { url: PROXY_SERVER } })
  : undefined;

function fetchWithProxy(input: Request | URL | string, init?: RequestInit) {
  return fetch(input, proxyClient ? { ...init, client: proxyClient } : init);
}

function sanitizeGroupId(groupId?: string | null): string | undefined {
  if (!groupId) return groupId ?? undefined;
  let cleaned = groupId.trim();
  ["/", "?", "#"].forEach((sep) => {
    const idx = cleaned.indexOf(sep);
    if (idx >= 0) cleaned = cleaned.slice(0, idx);
  });
  return cleaned;
}

function stripXssi(text: string) {
  const prefix = ")]}'";
  return text.startsWith(prefix) ? text.slice(prefix.length).trimStart() : text;
}

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const decoded = atob(padded);
  return Uint8Array.from(decoded, (c) => c.charCodeAt(0));
}

async function fetchJsonWithCheck(url: string, init: RequestInit, label: string) {
  const res = await fetchWithProxy(url, init);
  const text = await res.text();
  if (!res.ok) {
    console.error(`${label} failed`, res.status, res.statusText, text.slice(0, 200));
    throw new Error(`${label} failed: ${res.status}`);
  }
  try {
    return JSON.parse(stripXssi(text));
  } catch (err) {
    console.error(`${label} JSON parse error`, text.slice(0, 200), err);
    throw err;
  }
}

// 加载配置文件
function loadConfig() {
  const envConfig = {
    secure_c_ses: Deno.env.get("BIZ_GEMINI_SECURE_C_SES") ?? Deno.env.get("SECURE_C_SES"),
    host_c_oses: Deno.env.get("BIZ_GEMINI_HOST_C_OSES") ?? Deno.env.get("HOST_C_OSES"),
    csesidx: Deno.env.get("BIZ_GEMINI_CSESIDX") ?? Deno.env.get("CSESIDX"),
    group_id: sanitizeGroupId(Deno.env.get("BIZ_GEMINI_GROUP_ID") ?? Deno.env.get("CONFIG_ID")),
    proxy: Deno.env.get("BIZ_GEMINI_PROXY") ?? Deno.env.get("PROXY_SERVER"),
  };
  if (envConfig.secure_c_ses && envConfig.csesidx) return envConfig;
  if (IS_DEPLOY) return envConfig;

  try {
    const data = Deno.readTextFileSync(CONFIG_FILE);
    const fileCfg = JSON.parse(data);
    return {
      ...fileCfg,
      ...envConfig,
      group_id: sanitizeGroupId(envConfig.group_id ?? fileCfg.group_id),
    };
  } catch (e) {
    return envConfig;
  }
}

// 保存配置文件
function saveConfig(config: Record<string, any>) {
  if (IS_DEPLOY) return;
  config.saved_at = new Date().toISOString();
  Deno.writeTextFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { encoding: "utf-8" });
}

function ensureDir(path: string) {
  try {
    Deno.mkdirSync(path, { recursive: true });
  } catch (_) {
    // ignore
  }
}

// URL 安全的 Base64 编码
function urlSafeBase64Encode(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return encodeBase64(bytes).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// 模拟 Python 版的 kq_encode（处理 >255 的字符）
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

// 创建 JWT
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

// 从环境变量中获取JWT配置
async function getJwt(config: Record<string, any>) {
  const { secure_c_ses, host_c_oses, csesidx } = config;
  if (!secure_c_ses || !csesidx) {
    throw new Error("缺少 secure_c_ses 或 csesidx");
  }

  const cookieStr = `__Secure-C_SES=${secure_c_ses}${host_c_oses ? `; __Host-C_OSES=${host_c_oses}` : ""}`;
  const url = `${GETOXSRF_URL}?csesidx=${csesidx}`;

  return fetchJsonWithCheck(url, {
    headers: {
      accept: "*/*",
      "user-agent": "Mozilla/5.0",
      cookie: cookieStr,
    },
  }, "getOxSRF").then(async (data) => {
    if (!data.xsrfToken) {
      console.error("getOxSRF missing xsrfToken. Response:", data);
      throw new Error("xsrfToken_not_returned");
    }
    const keyBytes = base64UrlToBytes(data.xsrfToken);
    return await createJwt(keyBytes, data.keyId, csesidx);
  });
}

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

// 创建聊天会话
async function createChatSession(config: Record<string, any>, groupId: string = CONFIG_ID) {
  const sessionId = crypto.randomUUID().slice(0, 12);
  const body = {
    configId: groupId,
    additionalParams: { token: "-" },
    createSessionRequest: {
      session: { name: sessionId, displayName: sessionId },
    },
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const jwt = await getJwt(config);
    const res = await fetchWithProxy(CREATE_SESSION_URL, {
      method: "POST",
      headers: getHeaders(jwt),
      body: JSON.stringify(body),
    });
    const text = await res.text();

    if (res.status === 401 && attempt === 0) {
      // JWT 失效，刷新后再试一次
      continue;
    }

    if (!res.ok) {
      console.error("createSession failed", res.status, res.statusText, text.slice(0, 200));
      throw new Error(`createSession failed: ${res.status}`);
    }

    const data = JSON.parse(text);
    const name = data.session?.name;
    if (!name) {
      throw new Error("createSession success but no session name");
    }
    return name;
  }

  throw new Error("createSession failed after retries");
}

async function listSessionFileMetadata(config: Record<string, any>, sessionName: string, groupId: string) {
  const body = {
    configId: groupId,
    additionalParams: { token: "-" },
    listSessionFileMetadataRequest: {
      name: sessionName,
      filter: "file_origin_type = AI_GENERATED",
    },
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const jwt = await getJwt(config);
    const res = await fetchWithProxy(LIST_FILE_METADATA_URL, {
      method: "POST",
      headers: getHeaders(jwt),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status === 401 && attempt === 0) continue;
    if (!res.ok) {
      console.error("listSessionFileMetadata failed", res.status, res.statusText, text.slice(0, 200));
      return {};
    }
    try {
      const data = JSON.parse(text);
      const list = data.listSessionFileMetadataResponse?.fileMetadata ?? [];
      const result: Record<string, any> = {};
      list.forEach((fm: any) => {
        if (fm.fileId) result[fm.fileId] = fm;
      });
      return result;
    } catch (err) {
      console.error("listSessionFileMetadata parse failed", err);
      return {};
    }
  }

  return {};
}

async function downloadFileWithJwt(
  config: Record<string, any>,
  sessionName: string,
  fileId: string,
  mimeType: string,
): Promise<Uint8Array | undefined> {
  const url = `${DOWNLOAD_FILE_BASE}/${sessionName}:downloadFile?fileId=${fileId}&alt=media`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const jwt = await getJwt(config);
    const res = await fetchWithProxy(url, {
      headers: getHeaders(jwt),
      redirect: "follow",
    });
    if (res.status === 401 && attempt === 0) continue;
    if (!res.ok) {
      console.error("download file failed", res.status, res.statusText);
      continue;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf;
  }

  // fallback cookie
  const { secure_c_ses, host_c_oses } = config;
  if (!secure_c_ses) return undefined;
  const cookieStr = `__Secure-C_SES=${secure_c_ses}${host_c_oses ? `; __Host-C_OSES=${host_c_oses}` : ""}`;
  const res = await fetchWithProxy(url, {
    headers: {
      cookie: cookieStr,
      "user-agent": "Mozilla/5.0",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    console.error("download file with cookie failed", res.status, res.statusText);
    return undefined;
  }
  return new Uint8Array(await res.arrayBuffer());
}

// 发送消息并接收流式响应
async function streamChat(
  config: Record<string, any>,
  sessionName: string | undefined,
  message: string,
  groupId: string = CONFIG_ID,
  opts?: { includeThoughts?: boolean; autoSaveImages?: boolean; debugRaw?: boolean },
): Promise<{ reply?: string; session?: string; thoughts?: string[]; images?: any[]; raw?: string }> {
  const body = {
    configId: groupId,
    additionalParams: { token: "-" },
    streamAssistRequest: {
      session: sessionName,
      query: { parts: [{ text: message }] },
      filter: "",
      fileIds: [],
      answerGenerationMode: "NORMAL",
      toolsSpec: {
        webGroundingSpec: {},
        toolRegistry: "default_tool_registry",
        imageGenerationSpec: {},
        videoGenerationSpec: {},
      },
      languageCode: "zh-CN",
      userMetadata: { timeZone: "Etc/GMT-8" },
      assistSkippingMode: "REQUEST_ASSIST",
    },
  };

  let currentSession = sessionName;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (!currentSession) {
      currentSession = await createChatSession(config, groupId);
    }
    const jwt = await getJwt(config);

    const res = await fetchWithProxy(STREAM_ASSIST_URL, {
      method: "POST",
      headers: getHeaders(jwt),
      body: JSON.stringify({ ...body, streamAssistRequest: { ...body.streamAssistRequest, session: currentSession } }),
    });

    const text = await res.text();
    if (opts?.debugRaw) {
      console.log("raw streamAssist response:", text.slice(0, 500));
    }

    if (res.status === 401 && attempt < 2) {
      // JWT 可能失效，刷新后重试
      continue;
    }

    if (res.status === 404 && attempt < 2) {
      // session 可能失效，重建后重试
      currentSession = undefined;
      continue;
    }

    if (!res.ok) {
      console.error("Stream request failed", res.status, res.statusText, text.slice(0, 200));
      throw new Error(`Stream request failed: ${res.status}`);
    }

    const replies: string[] = [];
    const thoughts: string[] = [];
    const images: any[] = [];
    const fileIds: { fileId: string; mimeType?: string }[] = [];
    let currentSessionFromResp: string | undefined = currentSession;
    let rawCaptured: string | undefined = opts?.debugRaw ? text : undefined;

    try {
      const dataList = JSON.parse(text);
      dataList.forEach((item: any) => {
        const sar = item.streamAssistResponse;
        if (!sar) return;

        const sessionInfo = sar.sessionInfo;
        if (sessionInfo?.session) currentSessionFromResp = sessionInfo.session;

        const collectImage = (img: any) => {
          if (!img) return;
          const base64_data = img.image?.imageBytes ?? img.imageBytes ?? img.bytesBase64Encoded ?? img.data;
          const url = img.image?.uri ?? img.image?.imageUrl ?? img.image?.url ?? img.uri ?? img.imageUrl ?? img.url;
          const mime = img.image?.mimeType ?? img.mimeType ?? "image/png";
          const fileId = img.fileId;
          const fileName = img.name;
          images.push({ base64_data, url, mime_type: mime, file_id: fileId, file_name: fileName });
        };

        (sar.generatedImages ?? []).forEach(collectImage);

        const answer = sar.answer ?? {};
        (answer.generatedImages ?? []).forEach(collectImage);

        const repliesArr = answer.replies ?? [];
        repliesArr.forEach((reply: any) => {
          (reply.generatedImages ?? []).forEach(collectImage);

          const content = reply.groundedContent?.content ?? {};
          const gc = reply.groundedContent ?? {};

          const fileInfo = content.file;
          if (fileInfo?.fileId) {
            fileIds.push({ fileId: fileInfo.fileId, mimeType: fileInfo.mimeType });
          }

          const handleContent = (obj: any) => {
            if (!obj) return;
            if (obj.inlineData?.data) {
              images.push({ base64_data: obj.inlineData.data, mime_type: obj.inlineData.mimeType ?? "image/png" });
            }
            const imgUrl = obj.imageUrl ?? obj.uri ?? obj.url ?? obj.fileData?.fileUri;
            if (imgUrl) images.push({ url: imgUrl, mime_type: obj.mimeType ?? "image/png" });

            const parts = obj.parts ?? [];
            parts.forEach((p: any) => {
              if (p.inlineData?.data) {
                images.push({ base64_data: p.inlineData.data, mime_type: p.inlineData.mimeType ?? "image/png" });
              }
              const pUrl = p.imageUrl ?? p.uri ?? p.fileData?.fileUri;
              if (pUrl) images.push({ url: pUrl, mime_type: p.mimeType ?? "image/png" });
            });

            const attachments = obj.attachments ?? [];
            attachments.forEach((att: any) => {
              if ((att.mimeType ?? "").startsWith("image/")) {
                images.push({
                  base64_data: att.data ?? att.bytesBase64Encoded ?? att.imageBytes,
                  url: att.uri ?? att.url ?? att.imageUrl,
                  mime_type: att.mimeType,
                });
              }
            });
          };

          handleContent(content);
          handleContent(reply.groundedContent ?? {});

          const text = content.text ?? gc.text;
          const thought = content.thought ?? gc.thought;
          if (text) {
            if (thought) {
              if (opts?.includeThoughts) thoughts.push(text);
            } else {
              replies.push(text);
              console.log(text);
            }
          }
        });
      });
    } catch (err) {
      console.error("Failed to parse stream JSON", text.slice(0, 200), err);
    }

    // 下载 fileId 对应的图片
    if (fileIds.length && currentSessionFromResp) {
      ensureDir(IMAGE_SAVE_DIR);
      const meta = await listSessionFileMetadata(config, currentSessionFromResp, groupId);
      for (const finfo of fileIds) {
        const metaItem = meta[finfo.fileId];
        const fileName = metaItem?.name ?? `gemini_${finfo.fileId}.png`;
        const mimeType = finfo.mimeType ?? metaItem?.mimeType ?? "image/png";
        if (opts?.autoSaveImages === true) {
          try {
            const data = await downloadFileWithJwt(config, currentSessionFromResp, finfo.fileId, mimeType);
            if (data) {
              const filepath = join(IMAGE_SAVE_DIR, fileName);
              await Deno.writeFile(filepath, data);
              const base64_data = encodeBase64(data);
              images.push({
                local_path: filepath,
                file_id: finfo.fileId,
                mime_type: mimeType,
                file_name: fileName,
                base64_data,
              });
            }
          } catch (e) {
            console.error("save image failed", e);
          }
        } else {
          const download_url = `${DOWNLOAD_FILE_BASE}/${currentSessionFromResp}:downloadFile?fileId=${finfo.fileId}&alt=media`;
          images.push({
            file_id: finfo.fileId,
            file_name: fileName,
            mime_type: mimeType,
            download_url,
          });
        }
      }
    }

    return {
      reply: replies.length ? replies.join("\n") : undefined,
      session: currentSessionFromResp,
      thoughts,
      images,
      raw: rawCaptured,
    };
  }

  throw new Error("Stream request failed after retries");
}

function extractUserMessage(openaiBody: any): string {
  const messages = Array.isArray(openaiBody?.messages) ? openaiBody.messages : [];
  if (!messages.length) return "";
  const lines: string[] = [];
  for (const msg of messages) {
    const role = msg?.role ?? "user";
    const content = msg?.content;
    if (typeof content === "string") {
      lines.push(`${role}: ${content}`);
      continue;
    }
    if (Array.isArray(content)) {
      const texts = content
        .filter((p) => typeof p === "object" && p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text);
      if (texts.length) {
        lines.push(`${role}: ${texts.join("\n")}`);
      }
      continue;
    }
    lines.push(`${role}: `);
  }
  return lines.join("\n");
}

function countTokensApprox(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.trim().split(/\s+/).length));
}

function chunkContent(text: string, maxLen = 60): string[] {
  if (!text) return [""];
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  let current = "";

  words.forEach((word) => {
    if (!word) return;
    if ((current + " " + word).trim().length > maxLen && current.length > 0) {
      chunks.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  });

  if (current) chunks.push(current);
  return chunks;
}

function createOpenAIStreamResponse(
  reply: string,
  model: string,
  created: number,
  options?: { includeUsage?: boolean; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } },
) {
  const encoder = new TextEncoder();
  const id = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
  const parts = chunkContent(reply);

  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      };

      // 首条下发 role
      send({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      });

      parts.forEach((part) => {
        send({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: { content: part }, finish_reason: null }],
        });
      });

      send({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        ...(options?.includeUsage ? { usage: options.usage } : {}),
      });
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// HTML 页面
const htmlContent = `
<!DOCTYPE html>
<html lang="zh" data-theme="dark" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI 聊天室 · Gemini</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script>
    tailwind.config = {
      darkMode: "class",
      theme: {
        extend: {
          colors: {
            primary: "#38bdf8",
            secondary: "#a855f7",
            ink: "#0b132b",
          },
          fontFamily: {
            display: ['"Space Grotesk"', '"Noto Sans SC"', "Inter", "ui-sans-serif", "system-ui"],
          },
          boxShadow: {
            glass: "0 20px 80px rgba(15,23,42,0.45)",
          },
        },
      },
    };
    document.documentElement.dataset.theme = "dark";
    document.documentElement.classList.add("dark");
  </script>
  <style>
    :root {
      color-scheme: dark;
      --bg-gradient: radial-gradient(circle at 20% 20%, rgba(56, 189, 248, 0.14), transparent 22%),
                     radial-gradient(circle at 80% 0%, rgba(168, 85, 247, 0.12), transparent 20%),
                     #020617;
      --text: #e2e8f0;
      --muted: #cbd5e1;
      --card-bg: rgba(255, 255, 255, 0.05);
      --pill-bg: rgba(255, 255, 255, 0.08);
      --border: rgba(255, 255, 255, 0.1);
    }
    body {
      background: var(--bg-gradient);
      color: var(--text);
      font-family: "Space Grotesk", "Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .glass {
      backdrop-filter: blur(18px);
      background: var(--card-bg);
      border: 1px solid var(--border);
    }
    .pill {
      transition: transform 150ms ease, box-shadow 150ms ease, background-color 200ms ease;
      background: var(--pill-bg);
      border: 1px solid var(--border);
    }
    .pill:hover {
      transform: translateY(-1px);
      box-shadow: 0 10px 30px rgba(56, 189, 248, 0.25);
    }
    .toggle {
      position: relative;
      width: 34px;
      height: 20px;
      border-radius: 999px;
      background: rgba(15, 23, 42, 0.12);
      transition: background 0.2s ease, border 0.2s ease;
      border: 1px solid rgba(15, 23, 42, 0.12);
    }
    .toggle-dot {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: white;
      box-shadow: 0 3px 10px rgba(15, 23, 42, 0.2);
      transition: transform 0.2s ease;
    }
    .peer:checked + .toggle {
      background: linear-gradient(120deg, #38bdf8, #22c55e);
      border-color: rgba(56, 189, 248, 0.4);
    }
    .peer:checked + .toggle .toggle-dot {
      transform: translateX(14px);
    }
    .nav-btn {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      background: linear-gradient(145deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.03));
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #e7ecf7;
      border-radius: 14px;
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.12),
        0 10px 30px rgba(0, 0, 0, 0.25);
      transition: transform 120ms ease, box-shadow 120ms ease, background 160ms ease;
      text-decoration: none;
    }
    .nav-btn:hover {
      transform: translateY(-1px);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.18),
        0 14px 36px rgba(56, 189, 248, 0.22);
      background: linear-gradient(145deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.05));
    }
    .nav-primary {
      background: linear-gradient(135deg, #38bdf8, #22d3ee);
      color: #0b1221;
      box-shadow:
        0 14px 30px rgba(56, 189, 248, 0.55),
        0 1px 0 rgba(255, 255, 255, 0.4);
      border: none;
    }
    .nav-primary:hover {
      filter: brightness(1.05);
      transform: translateY(-1px);
    }
    .response-body {
      max-height: 60vh;
      overflow: auto;
      word-break: break-word;
      white-space: pre-wrap;
    }
  </style>
</head>
<body class="min-h-screen text-slate-100 flex items-center justify-center p-4">
  <div class="w-full max-w-6xl grid gap-4 lg:grid-cols-[2fr,1fr] items-start">
    <main class="glass rounded-2xl shadow-glass p-6">
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="text-xs uppercase tracking-[0.3em] text-sky-700/70 dark:text-sky-200/70">Gemini Console</p>
          <h1 class="text-3xl font-semibold text-slate-900 dark:text-white mt-1">AI 聊天室</h1>
          <p class="text-sm text-slate-600 dark:text-slate-300 mt-1">极速调试 Gemini Business，流式伪装兼容 ChatGPT 客户端。</p>
        </div>
        <div class="flex items-center gap-3">
          <a href="/docs" class="nav-btn h-11 px-4 text-sm font-semibold">文档</a>
          <a href="https://dash.deno.com/playground/gemini2deno" target="_blank" rel="noopener"
             class="nav-btn h-11 px-4 text-sm font-semibold">
            源码
          </a>
          <button id="sendBtn" class="nav-btn nav-primary h-11 px-5 text-sm font-semibold">
            发送
          </button>
        </div>
      </div>

      <div class="mt-6">
        <label for="message" class="text-sm text-slate-700 dark:text-slate-300">你的问题</label>
        <div class="relative mt-2">
          <textarea id="message" rows="4" class="w-full rounded-2xl border border-white/20 bg-white/70 dark:bg-white/5 text-slate-900 dark:text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-sky-400 focus:border-sky-400 transition p-4 pr-28"
            placeholder="输入你的问题，Enter 发送，Shift + Enter 换行"></textarea>
          <div class="absolute bottom-3 right-4 text-xs text-slate-500 dark:text-slate-400">Enter 发送</div>
        </div>
      </div>

      <div class="mt-4">
        <p class="text-xs uppercase tracking-[0.2em] text-sky-200/70">快捷提问</p>
        <div id="presetList" class="flex flex-wrap gap-2 mt-2"></div>
      </div>

      <div class="flex flex-wrap items-center gap-3 mt-4">
        <label class="pill inline-flex items-center gap-2 px-4 py-2 rounded-full cursor-pointer text-slate-200">
          <input type="checkbox" id="showThoughts" class="peer sr-only">
          <span class="toggle"><span class="toggle-dot"></span></span>
          <span class="text-sm">显示思考链</span>
        </label>
        <label class="pill inline-flex items-center gap-2 px-4 py-2 rounded-full cursor-pointer text-slate-200">
          <input type="checkbox" id="saveImages" class="peer sr-only">
          <span class="toggle"><span class="toggle-dot"></span></span>
          <span class="text-sm">下载并展示图片</span>
        </label>
        <label class="pill inline-flex items-center gap-2 px-4 py-2 rounded-full cursor-pointer text-slate-200">
          <input type="checkbox" id="showRaw" class="peer sr-only">
          <span class="toggle"><span class="toggle-dot"></span></span>
          <span class="text-sm">显示原始返回</span>
        </label>
        <button id="clearRawBtn" class="pill px-4 py-2 rounded-full text-sm text-slate-200">清空原始返回</button>
      </div>

      <div id="responseCard" class="mt-6 hidden">
        <div class="flex items-center justify-between text-slate-600 dark:text-slate-300 text-sm mb-2">
          <span class="font-medium text-slate-800 dark:text-slate-100">AI 回复</span>
          <span id="statusDot" class="h-2 w-2 rounded-full bg-sky-400 shadow-lg shadow-sky-500/50"></span>
        </div>
        <div id="response" class="glass rounded-xl p-4 text-base leading-relaxed response-body"></div>
      </div>

      <div id="thoughtsCard" class="mt-4 hidden">
        <div class="flex items-center gap-2 text-slate-600 dark:text-slate-300 text-sm mb-2">
          <span class="font-medium text-slate-800 dark:text-slate-100">思考链</span>
          <span class="text-[11px] px-2 py-1 rounded-full bg-amber-400/20 text-amber-200 border border-amber-200/30">调试</span>
        </div>
        <div id="thoughts" class="glass rounded-xl border border-amber-200/30 p-3 text-sm text-amber-800 dark:text-amber-50 space-y-2"></div>
      </div>

      <div id="imagesCard" class="mt-4 hidden">
        <div class="flex items-center gap-2 text-slate-600 dark:text-slate-300 text-sm mb-2">
          <span class="font-medium text-slate-800 dark:text-slate-100">返回图片</span>
          <span class="text-[11px] px-2 py-1 rounded-full bg-sky-400/20 text-sky-100 border border-sky-200/30">预览</span>
        </div>
        <div id="images" class="grid gap-3 sm:grid-cols-2 md:grid-cols-3"></div>
      </div>

      <div id="debugCard" class="mt-4 hidden">
        <div class="flex items-center justify-between text-slate-600 dark:text-slate-300 text-sm mb-2">
          <span class="font-medium text-slate-800 dark:text-slate-100">原始返回</span>
        </div>
        <pre id="debugRawBox" class="glass rounded-xl p-3 text-xs text-slate-800 dark:text-slate-200 overflow-auto max-h-64 whitespace-pre-wrap"></pre>
      </div>
    </main>

    <aside class="glass rounded-2xl shadow-glass p-5 space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <p class="text-xs uppercase tracking-[0.2em] text-sky-700/70 dark:text-sky-200/70">Quick Settings</p>
          <p class="text-base text-slate-900 dark:text-white font-medium mt-1">调试选项</p>
        </div>
        <span class="px-2 py-1 text-xs rounded-full bg-sky-400/20 text-sky-100 border border-sky-200/40">实时</span>
      </div>
      <div class="space-y-3 text-sm text-slate-700 dark:text-slate-200">
        <p class="text-slate-700 dark:text-slate-200">支持 OpenAI 兼容接口（伪流式 SSE），便于和 ChatGPT 客户端联调。</p>
        <ul class="space-y-2 list-disc list-inside text-slate-600 dark:text-slate-300">
          <li>先在 .env 写入 BIZ_GEMINI_* 或 alias 变量。</li>
          <li>可切换是否保存图片或展示思考链。</li>
          <li>开启原始返回方便排查字段。</li>
        </ul>
      </div>
      <div class="border-t border-slate-200/60 dark:border-white/10 pt-4 space-y-3">
        <div class="flex items-center justify-between">
          <p class="text-sm font-medium text-slate-900 dark:text-slate-100">填写变量</p>
          <span class="text-[11px] px-2 py-1 rounded-full bg-emerald-400/20 text-emerald-900 dark:text-emerald-100 border border-emerald-200/40">本地</span>
        </div>
        <div class="space-y-2">
          <label class="block text-xs text-slate-600 dark:text-slate-300">
            __Secure-C_SES
            <input id="cfgSecure" class="mt-1 w-full rounded-xl border border-slate-200 dark:border-white/10 bg-white/60 dark:bg-white/5 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400" placeholder="必填">
          </label>
          <label class="block text-xs text-slate-600 dark:text-slate-300">
            __Host-C_OSES
            <input id="cfgHost" class="mt-1 w-full rounded-xl border border-slate-200 dark:border-white/10 bg-white/60 dark:bg-white/5 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400" placeholder="可选">
          </label>
          <label class="block text-xs text-slate-600 dark:text-slate-300">
            CSESIDX
            <input id="cfgCsesidx" class="mt-1 w-full rounded-xl border border-slate-200 dark:border-white/10 bg-white/60 dark:bg-white/5 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400" placeholder="必填">
          </label>
          <label class="block text-xs text-slate-600 dark:text-slate-300">
            GROUP_ID / CONFIG_ID
            <input id="cfgGroupId" class="mt-1 w-full rounded-xl border border-slate-200 dark:border-white/10 bg-white/60 dark:bg-white/5 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400" placeholder="默认内置，可选">
          </label>
          <label class="block text-xs text-slate-600 dark:text-slate-300">
            PROXY_SERVER
            <input id="cfgProxy" class="mt-1 w-full rounded-xl border border-slate-200 dark:border-white/10 bg-white/60 dark:bg-white/5 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400" placeholder="http://127.0.0.1:7890">
          </label>
        </div>
        <div class="flex items-center gap-3">
          <button id="configSaveBtn" class="pill px-4 py-2 rounded-xl text-sm text-slate-900 dark:text-slate-100 bg-gradient-to-r from-emerald-400 to-green-300 shadow-lg shadow-emerald-400/30">保存配置</button>
          <span id="configStatus" class="text-xs text-slate-500 dark:text-slate-300"></span>
        </div>
        <p class="text-[11px] text-slate-500 dark:text-slate-400">写入本地 business_gemini_session.json；部署环境可能不持久化。</p>
      </div>
    </aside>
  </div>

  <div id="lightbox" class="fixed inset-0 bg-black/70 hidden items-center justify-center p-4 z-50">
    <div class="relative max-w-5xl w-full">
      <button id="lightboxClose" class="absolute -top-10 right-0 text-white/80 hover:text-white text-2xl leading-none">×</button>
      <img id="lightboxImg" src="" alt="preview" class="w-full max-h-[80vh] object-contain rounded-2xl border border-white/10 shadow-2xl">
    </div>
  </div>

  <script>
    const $message = $("#message");
    const $sendBtn = $("#sendBtn");
    const $responseCard = $("#responseCard");
    const $response = $("#response");
    const $imagesCard = $("#imagesCard");
    const $images = $("#images");
    const $thoughtsCard = $("#thoughtsCard");
    const $thoughts = $("#thoughts");
    const $debugCard = $("#debugCard");
    const $debugRawBox = $("#debugRawBox");
    const $statusDot = $("#statusDot");
    const $lightbox = $("#lightbox");
    const $lightboxImg = $("#lightboxImg");
    const $cfgSecure = $("#cfgSecure");
    const $cfgHost = $("#cfgHost");
    const $cfgCsesidx = $("#cfgCsesidx");
    const $cfgGroupId = $("#cfgGroupId");
    const $cfgProxy = $("#cfgProxy");
    const $configSaveBtn = $("#configSaveBtn");
    const $configStatus = $("#configStatus");
    const $presetList = $("#presetList");

    const presetMessages = [
      "今天发生了哪些国际性新闻",
      "写一段 100 字以内的产品介绍，产品：AI 聊天室调试页面。",
      "给出三个提升前端加载性能的建议。",
      "生成一段用于测试的中文 Lorem 文本，80 字左右。",
    ];

    function toggleLoading(loading) {
      if (loading) {
        $sendBtn.text("发送中...").addClass("opacity-60 pointer-events-none");
        $statusDot.removeClass("bg-sky-400").addClass("bg-amber-300");
      } else {
        $sendBtn.text("发送").removeClass("opacity-60 pointer-events-none");
        $statusDot.removeClass("bg-amber-300").addClass("bg-sky-400");
      }
    }

    async function sendMessage() {
      const message = $message.val().trim();
      if (!message) {
        $message.addClass("ring-2 ring-rose-400");
        setTimeout(() => $message.removeClass("ring-2 ring-rose-400"), 600);
        return;
      }
      toggleLoading(true);
      $responseCard.removeClass("hidden");
      $response.text("正在处理...");
      $imagesCard.addClass("hidden");
      $images.empty();
      $thoughtsCard.addClass("hidden");
      $thoughts.empty();
      $debugCard.toggleClass("hidden", !$("#showRaw").prop("checked"));
      $debugRawBox.text("");

      const payload = {
        message,
        includeThoughts: $("#showThoughts").prop("checked"),
        autoSaveImages: $("#saveImages").prop("checked"),
        debugRaw: $("#showRaw").prop("checked"),
      };

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        renderResponse(data);
      } catch (err) {
        $response.text("请求失败，请检查服务是否运行。" + (err?.message ? " (" + err.message + ")" : ""));
      } finally {
        toggleLoading(false);
      }
    }

    function renderResponse(data) {
      if (data.reply) {
        try {
          $response.html(marked.parse(data.reply, { breaks: true }));
        } catch (_) {
          $response.text(data.reply);
        }
      } else {
        $response.text("没有回答。");
      }

      const imgs = Array.isArray(data.images) ? data.images : [];
      if (imgs.length) {
        const frag = $(document.createDocumentFragment());
        imgs.forEach((img) => {
          const src = img.base64_data
            ? "data:" + (img.mime_type || "image/png") + ";base64," + img.base64_data
            : (img.url || "");
          if (src) {
            const $img = $("<img>")
              .attr("src", src)
              .attr("alt", img.file_name || img.file_id || "image")
              .addClass("w-full rounded-xl border border-white/10 object-cover aspect-video cursor-zoom-in hover:opacity-90 transition");
            $img.on("click", () => openLightbox(src, $img.attr("alt")));
            frag.append($("<div>").append($img));
            return;
          }
          if (img.download_url) {
            const $link = $("<a>")
              .attr("href", img.download_url)
              .attr("target", "_blank")
              .attr("rel", "noopener")
              .text(img.file_name || img.file_id || "下载图片")
              .addClass("text-sm text-sky-600 dark:text-sky-200 underline underline-offset-4");
            frag.append($("<div>").addClass("p-2 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-white/5").append($link));
          }
        });
        if (frag.children().length) {
          $images.html(frag);
          $imagesCard.removeClass("hidden");
        } else {
          $imagesCard.addClass("hidden");
        }
      } else {
        $imagesCard.addClass("hidden");
      }

      const ths = Array.isArray(data.thoughts) ? data.thoughts : [];
      if ($("#showThoughts").prop("checked") && ths.length) {
        $thoughts.html(ths.map((t) => '<div class="flex gap-2"><span class="text-sky-200">🧠</span><span>' + t + "</span></div>").join(""));
        $thoughtsCard.removeClass("hidden");
      } else {
        $thoughtsCard.addClass("hidden");
      }

      if ($("#showRaw").prop("checked") && data.raw) {
        $debugRawBox.text(data.raw);
        $debugCard.removeClass("hidden");
      } else {
        $debugCard.addClass("hidden");
      }
    }

    function clearRaw() {
      $debugRawBox.text("");
      $debugCard.addClass("hidden");
    }

    function openLightbox(src, alt) {
      $lightboxImg.attr("src", src || "").attr("alt", alt || "preview");
      $lightbox.removeClass("hidden").addClass("flex");
    }

    function closeLightbox() {
      $lightbox.addClass("hidden").removeClass("flex");
      $lightboxImg.attr("src", "");
    }

    $("#lightbox, #lightboxClose").on("click", (e) => {
      if (e.target === e.currentTarget) closeLightbox();
    });
    $(document).on("keydown", (e) => {
      if (e.key === "Escape" && !$lightbox.hasClass("hidden")) closeLightbox();
    });

    $sendBtn.on("click", sendMessage);
    $("#clearRawBtn").on("click", clearRaw);
    $message.on("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    $message.trigger("focus");

    function renderPresets() {
      const frag = $(document.createDocumentFragment());
      presetMessages.forEach((text) => {
        const $btn = $("<button>")
          .addClass("pill px-4 py-2 rounded-full text-sm text-slate-100 hover:bg-white/10 transition border border-white/10")
          .text(text)
          .on("click", () => {
            $message.val(text);
            sendMessage();
          });
        frag.append($btn);
      });
      $presetList.html(frag);
    }

    function setConfigStatus(text, tone = "muted") {
      $configStatus
        .text(text || "")
        .removeClass("text-emerald-500 text-amber-500 text-rose-500 text-slate-500 dark:text-slate-300")
        .addClass(tone === "error" ? "text-rose-500" : tone === "warn" ? "text-amber-500" : "text-emerald-500");
    }

    async function loadConfigUI() {
      try {
        const res = await fetch("/api/config");
        const data = await res.json();
        $cfgSecure.val(data.secure_c_ses || "");
        $cfgHost.val(data.host_c_oses || "");
        $cfgCsesidx.val(data.csesidx || "");
        $cfgGroupId.val(data.group_id || "");
        $cfgProxy.val(data.proxy || "");
        setConfigStatus("已读取本地配置", "ok");
      } catch (err) {
        setConfigStatus("读取配置失败", "error");
        console.error(err);
      }
    }

    async function saveConfigUI() {
      const payload = {
        secure_c_ses: ($cfgSecure.val() || "").toString().trim(),
        host_c_oses: ($cfgHost.val() || "").toString().trim(),
        csesidx: ($cfgCsesidx.val() || "").toString().trim(),
        group_id: ($cfgGroupId.val() || "").toString().trim(),
        proxy: ($cfgProxy.val() || "").toString().trim(),
      };
      if (!payload.secure_c_ses || !payload.csesidx) {
        setConfigStatus("secure_c_ses 与 csesidx 为必填", "warn");
        return;
      }
      setConfigStatus("保存中...", "warn");
      try {
        const res = await fetch("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        setConfigStatus(data.message || (data.persisted ? "已保存" : "已接收"));
      } catch (err) {
        setConfigStatus("保存失败", "error");
        console.error(err);
      }
    }

    $configSaveBtn.on("click", saveConfigUI);
    renderPresets();
    loadConfigUI();
  </script>
</body>
</html>
`;

const docsContent = `
<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gemini Biz Docs</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-50 text-slate-900">
  <div class="max-w-4xl mx-auto p-6 space-y-8">
    <header class="flex items-center justify-between">
      <div>
        <p class="text-xs uppercase tracking-[0.3em] text-sky-600">Gemini Business</p>
        <h1 class="text-3xl font-semibold mt-1">本地联调文档</h1>
        <p class="text-sm text-slate-600 mt-2">OpenAI 兼容伪流接口 + 配置面板 + 示例页面</p>
      </div>
      <a href="/" class="text-sm text-sky-600 underline underline-offset-4">返回聊天室</a>
    </header>

    <section class="bg-white rounded-2xl shadow border border-slate-200 p-6 space-y-2">
      <h2 class="text-xl font-semibold">启动</h2>
      <ol class="list-decimal list-inside text-sm text-slate-700 space-y-1">
        <li>安装依赖（可选）：<code class="bg-slate-100 px-2 py-1 rounded">pnpm i</code></li>
        <li>运行：<code class="bg-slate-100 px-2 py-1 rounded">pnpx deno run --allow-net --allow-env --allow-read --allow-write gemini.ts</code></li>
        <li>浏览器打开 <code class="bg-slate-100 px-2 py-1 rounded">http://localhost:8787/</code></li>
      </ol>
      <p class="text-sm text-slate-600">部署到 Deno Deploy 时，配置文件不保证持久化。</p>
    </section>

    <section class="bg-white rounded-2xl shadow border border-slate-200 p-6 space-y-2">
      <h2 class="text-xl font-semibold">必填变量</h2>
      <ul class="list-disc list-inside text-sm text-slate-700 space-y-1">
        <li><code class="bg-slate-100 px-1 rounded">BIZ_GEMINI_SECURE_C_SES</code> / <code class="bg-slate-100 px-1 rounded">SECURE_C_SES</code></li>
        <li><code class="bg-slate-100 px-1 rounded">BIZ_GEMINI_CSESIDX</code> / <code class="bg-slate-100 px-1 rounded">CSESIDX</code></li>
        <li>可选：<code class="bg-slate-100 px-1 rounded">BIZ_GEMINI_HOST_C_OSES</code>、<code class="bg-slate-100 px-1 rounded">BIZ_GEMINI_GROUP_ID</code>、<code class="bg-slate-100 px-1 rounded">BIZ_GEMINI_PROXY</code></li>
      </ul>
      <p class="text-sm text-slate-600">在 UI 右侧“填写变量”中可直接写入 <code class="bg-slate-100 px-1 rounded">business_gemini_session.json</code>（本地）。</p>
    </section>

    <section class="bg-white rounded-2xl shadow border border-slate-200 p-6 space-y-2">
      <h2 class="text-xl font-semibold">接口</h2>
      <ul class="list-disc list-inside text-sm text-slate-700 space-y-1">
        <li>GET <code class="bg-slate-100 px-1 rounded">/v1/models</code> — OpenAI 兼容列表</li>
        <li>POST <code class="bg-slate-100 px-1 rounded">/v1/chat/completions</code> — 支持 <code class="bg-slate-100 px-1 rounded">stream</code> 与 <code class="bg-slate-100 px-1 rounded">stream_options.include_usage</code></li>
        <li>POST <code class="bg-slate-100 px-1 rounded">/api/chat</code> — 示例接口（文本+图片+思考链）</li>
        <li>GET/POST <code class="bg-slate-100 px-1 rounded">/api/config</code> — 读取/保存本地配置文件</li>
        <li>GET <code class="bg-slate-100 px-1 rounded">/docs</code> — 当前页面</li>
      </ul>
      <p class="text-sm text-slate-600">流响应为“伪流”：先拿到完整回复，再按块推送 SSE。</p>
    </section>

    <section class="bg-white rounded-2xl shadow border border-slate-200 p-6 space-y-2">
      <h2 class="text-xl font-semibold">调试提示</h2>
      <ul class="list-disc list-inside text-sm text-slate-700 space-y-1">
        <li>勾选“显示原始返回”获取完整 JSON，便于排查字段。</li>
        <li>“下载并展示图片”会写入 <code class="bg-slate-100 px-1 rounded">biz_gemini_images</code> 并回传 base64。</li>
        <li>若 401/404，内部会自动刷新 JWT 或重建 session 后重试。</li>
      </ul>
    </section>
  </div>
</body>
</html>
`;

// 启动 Deno 服务器
async function handleRequest(req: Request) {
  try {
    const pathname = new URL(req.url).pathname;
    if (req.method === "GET" && pathname === "/docs") {
      return new Response(docsContent, { headers: { "Content-Type": "text/html" } });
    }

    if (req.method === "GET" && pathname === "/api/config") {
      const cfg = loadConfig();
      const payload = {
        secure_c_ses: cfg.secure_c_ses ?? "",
        host_c_oses: cfg.host_c_oses ?? "",
        csesidx: cfg.csesidx ?? "",
        group_id: cfg.group_id ?? "",
        proxy: cfg.proxy ?? "",
      };
      return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
    }

    if (req.method === "POST" && pathname === "/api/config") {
      const body = await req.json().catch(() => ({}));
      const cfg = {
        secure_c_ses: typeof body.secure_c_ses === "string" ? body.secure_c_ses.trim() : "",
        host_c_oses: typeof body.host_c_oses === "string" ? body.host_c_oses.trim() : "",
        csesidx: typeof body.csesidx === "string" ? body.csesidx.trim() : "",
        group_id: sanitizeGroupId(typeof body.group_id === "string" ? body.group_id.trim() : ""),
        proxy: typeof body.proxy === "string" ? body.proxy.trim() : "",
      };

      const willPersist = !IS_DEPLOY;
      if (willPersist) {
        saveConfig(cfg);
      }

      return new Response(JSON.stringify({
        ok: true,
        persisted: willPersist,
        config: cfg,
        message: willPersist ? "已保存到 business_gemini_session.json" : "部署环境不支持持久化，已接收但未写盘",
      }), { headers: { "Content-Type": "application/json" } });
    }

    if (req.method === "GET" && pathname === "/v1/models") {
      const model = MODEL_NAME;
      return new Response(JSON.stringify({
        object: "list",
        data: [{ id: model, object: "model", owned_by: "gemini" }],
      }), { headers: { "Content-Type": "application/json" } });
    }

    if (req.method === "POST" && pathname === "/v1/chat/completions") {
      const body = await req.json();
      const userMessage = extractUserMessage(body);
      if (!userMessage) {
        return new Response(JSON.stringify({ error: { message: "user message missing" } }), { status: 400 });
      }

      const config = loadConfig();
      const groupId = config.group_id ?? CONFIG_ID;
      const includeThoughts = body.includeThoughts ?? body.include_thoughts ?? true;
      const autoSaveImages = body.autoSaveImages ?? body.auto_save_images ?? false;
      const debugRaw = body.debugRaw === true;
      const session = await createChatSession(config, groupId);
      const { reply, thoughts, images, raw } = await streamChat(config, session, userMessage, groupId, {
        includeThoughts,
        autoSaveImages,
        debugRaw,
      });

      const now = Math.floor(Date.now() / 1000);
      const choice = {
        index: 0,
        message: { role: "assistant", content: reply ?? "" },
        finish_reason: "stop",
      };
      const promptTokens = countTokensApprox(userMessage);
      const completionTokens = countTokensApprox(reply ?? "");

      const respBody = {
        id: `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`,
        object: "chat.completion",
        created: now,
        model: body.model ?? MODEL_NAME,
        choices: [choice],
        extra: {
          thoughts,
          images,
          raw: debugRaw ? raw : undefined,
        },
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };

      if (body.stream === true) {
        const includeUsage = body.stream_options?.include_usage === true;
        // 流式暂不传 thoughts/images，客户端通常不处理二进制；按文本分块返回
        return createOpenAIStreamResponse(respBody.choices[0].message.content ?? "", respBody.model, respBody.created, {
          includeUsage,
          usage: respBody.usage,
        });
      }

      return new Response(JSON.stringify(respBody), { headers: { "Content-Type": "application/json" } });
    }

    if (req.method === "POST" && pathname === "/api/chat") {
      const { message, includeThoughts = true, autoSaveImages = false, debugRaw = false } = await req.json();
      const config = loadConfig();
      const groupId = config.group_id ?? CONFIG_ID;
      const session = await createChatSession(config, groupId);
      const { reply, images, thoughts, raw } = await streamChat(config, session, message, groupId, {
        includeThoughts,
        autoSaveImages,
        debugRaw,
      });

      return new Response(JSON.stringify({
        reply: reply ?? "没有回答。",
        images: images ?? [],
        thoughts: thoughts ?? [],
        raw: debugRaw ? raw : undefined,
      }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(htmlContent, { headers: { "Content-Type": "text/html" } });
  } catch (err) {
    console.error("Request handling failed", err);
    return new Response(JSON.stringify({ error: "server_error" }), { status: 500 });
  }
}

const PORT = Number(Deno.env.get("PORT") ?? "8787");
if (IS_DEPLOY) {
  console.log("Running on Deno Deploy");
  Deno.serve(handleRequest);
} else {
  console.log(`Server listening on http://localhost:${PORT}`);
  Deno.serve({ port: PORT }, handleRequest);
}
