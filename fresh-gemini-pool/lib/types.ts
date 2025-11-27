// Business Gemini Pool - TypeScript 类型定义

export interface Account {
  id: string;
  team_id: string;
  secure_c_ses: string;
  host_c_oses: string;
  csesidx: string;
  user_agent: string;
  available: boolean;
  unavailable_reason?: string;
  unavailable_time?: string;
  created_at: number;
}

export interface Model {
  id: string;
  name: string;
  description: string;
  context_length: number;
  max_tokens: number;
  is_public: boolean;
  enabled?: boolean;
}

export interface JWTCache {
  jwt: string;
  expires_at: number;
}

export interface SessionCache {
  session_id: string;
  created_at: number;
}

export interface ImageCache {
  data: Uint8Array;
  mime_type: string;
  file_name: string;
  created_at: number;
}

export interface Config {
  proxy?: string;
  image_base_url?: string;
}

// OpenAI 兼容类型
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatMessageContent[];
}

export interface ChatMessageContent {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
  };
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stop?: string | string[];
  max_tokens?: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: {
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: {
    index: number;
    delta: Partial<ChatMessage>;
    finish_reason: string | null;
  }[];
}

// Gemini API 类型
export interface GeminiResponse {
  text: string;
  images?: Array<{
    url?: string;
    base64?: string;
    file_name?: string;
  }>;
}
