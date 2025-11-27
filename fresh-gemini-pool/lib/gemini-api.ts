import type { Account, GeminiResponse, ChatMessage } from "./types.ts";

const BASE_URL = "https://biz-discoveryengine.googleapis.com/v1alpha/locations/global";
const STREAM_ASSIST_URL = `${BASE_URL}/widgetStreamAssist`;
const DOWNLOAD_FILE_BASE = "https://biz-discoveryengine.googleapis.com/v1alpha";
const LIST_FILE_METADATA_URL = `${BASE_URL}/widgetListSessionFileMetadata`;

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
 * 提取消息中的文本内容
 */
function extractTextFromMessage(message: ChatMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  // 处理包含图片的消息
  if (Array.isArray(message.content)) {
    return message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text || "")
      .join("\n");
  }

  return "";
}

/**
 * 流式聊天请求
 */
export async function streamChat(params: {
  jwt: string;
  session: string;
  messages: ChatMessage[];
  teamId: string;
  proxy?: string;
}): Promise<GeminiResponse> {
  const { jwt, session, messages, teamId, proxy } = params;

  // 提取最后一条用户消息
  const lastUserMessage = messages.filter((m) => m.role === "user").pop();
  if (!lastUserMessage) {
    throw new Error("No user message found");
  }

  const messageText = extractTextFromMessage(lastUserMessage);

  const body = {
    configId: teamId,
    additionalParams: { token: "-" },
    streamAssistRequest: {
      session: session,
      query: { parts: [{ text: messageText }] },
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

  const res = await fetch(STREAM_ASSIST_URL, fetchOptions);
  const text = await res.text();

  if (!res.ok) {
    console.error("Stream request failed", res.status, res.statusText, text.slice(0, 200));
    throw new Error(`Stream request failed: ${res.status}`);
  }

  // 解析响应
  const replies: string[] = [];
  const images: Array<{
    base64_data?: string;
    url?: string;
    mime_type?: string;
    file_id?: string;
    file_name?: string;
  }> = [];

  try {
    const dataList = JSON.parse(text);
    dataList.forEach((item: any) => {
      const sar = item.streamAssistResponse;
      if (!sar) return;

      // 收集图片
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

      // 收集文本回复
      const repliesArr = answer.replies ?? [];
      repliesArr.forEach((reply: any) => {
        const content = reply.content ?? {};
        const parts = content.parts ?? [];
        parts.forEach((part: any) => {
          if (part.text) {
            replies.push(part.text);
          }
        });
      });
    });
  } catch (err) {
    console.error("Parse response error:", text.slice(0, 200), err);
    throw err;
  }

  return {
    text: replies.join("\n"),
    images: images.length > 0 ? images : undefined,
  };
}

/**
 * 下载文件（使用 JWT）
 */
export async function downloadFileWithJWT(params: {
  jwt: string;
  session: string;
  fileId: string;
  proxy?: string;
}): Promise<Uint8Array | undefined> {
  const { jwt, session, fileId, proxy } = params;
  const url = `${DOWNLOAD_FILE_BASE}/${session}:downloadFile?fileId=${fileId}&alt=media`;

  const fetchOptions: RequestInit = {
    headers: getHeaders(jwt),
    redirect: "follow",
  };

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
    console.error("Download file failed", res.status, res.statusText);
    return undefined;
  }

  return new Uint8Array(await res.arrayBuffer());
}

/**
 * 列出会话文件元数据
 */
export async function listSessionFileMetadata(params: {
  jwt: string;
  session: string;
  teamId: string;
  proxy?: string;
}): Promise<Record<string, any>> {
  const { jwt, session, teamId, proxy } = params;

  const body = {
    configId: teamId,
    additionalParams: { token: "-" },
    listSessionFileMetadataRequest: {
      name: session,
      filter: "file_origin_type = AI_GENERATED",
    },
  };

  const fetchOptions: RequestInit = {
    method: "POST",
    headers: getHeaders(jwt),
    body: JSON.stringify(body),
  };

  if (proxy) {
    try {
      const proxyClient = Deno.createHttpClient({ proxy: { url: proxy } });
      (fetchOptions as any).client = proxyClient;
    } catch (e) {
      console.warn("Failed to create proxy client:", e);
    }
  }

  const res = await fetch(LIST_FILE_METADATA_URL, fetchOptions);
  const text = await res.text();

  if (!res.ok) {
    console.error("List file metadata failed", res.status, res.statusText, text.slice(0, 200));
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
    console.error("Parse file metadata failed", err);
    return {};
  }
}
