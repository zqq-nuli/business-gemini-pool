import type { Config, Model } from "./types.ts";

/**
 * 配置存储管理器（基于 Deno KV）
 */
export class ConfigStore {
  private kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this.kv = kv;
  }

  /**
   * 获取代理配置
   */
  async getProxy(): Promise<string | null> {
    const res = await this.kv.get<string>(["config", "proxy"]);
    return res.value;
  }

  /**
   * 设置代理配置
   */
  async setProxy(proxy: string): Promise<void> {
    await this.kv.set(["config", "proxy"], proxy);
  }

  /**
   * 获取图片基础 URL
   */
  async getImageBaseUrl(): Promise<string | null> {
    const res = await this.kv.get<string>(["config", "image_base_url"]);
    return res.value;
  }

  /**
   * 设置图片基础 URL
   */
  async setImageBaseUrl(url: string): Promise<void> {
    await this.kv.set(["config", "image_base_url"], url);
  }

  /**
   * 获取完整配置
   */
  async getConfig(): Promise<Config> {
    const proxy = await this.getProxy();
    const imageBaseUrl = await this.getImageBaseUrl();
    return {
      proxy: proxy || undefined,
      image_base_url: imageBaseUrl || undefined,
    };
  }

  /**
   * 更新配置
   */
  async updateConfig(config: Partial<Config>): Promise<void> {
    if (config.proxy !== undefined) {
      await this.setProxy(config.proxy);
    }
    if (config.image_base_url !== undefined) {
      await this.setImageBaseUrl(config.image_base_url);
    }
  }

  /**
   * 列出所有模型
   */
  async listModels(): Promise<Model[]> {
    const entries = this.kv.list<Model>({ prefix: ["models"] });
    const models: Model[] = [];
    for await (const entry of entries) {
      models.push(entry.value);
    }
    return models;
  }

  /**
   * 获取单个模型
   */
  async getModel(id: string): Promise<Model | null> {
    const res = await this.kv.get<Model>(["models", id]);
    return res.value;
  }

  /**
   * 创建模型
   */
  async createModel(model: Model): Promise<void> {
    await this.kv.set(["models", model.id], model);
  }

  /**
   * 更新模型
   */
  async updateModel(id: string, data: Partial<Model>): Promise<boolean> {
    const existing = await this.getModel(id);
    if (!existing) return false;

    const updated = { ...existing, ...data };
    await this.kv.set(["models", id], updated);
    return true;
  }

  /**
   * 删除模型
   */
  async deleteModel(id: string): Promise<boolean> {
    const existing = await this.getModel(id);
    if (!existing) return false;

    await this.kv.delete(["models", id]);
    return true;
  }

  /**
   * 初始化默认模型（如果不存在）
   */
  async initializeDefaultModels(): Promise<void> {
    const existingModels = await this.listModels();
    if (existingModels.length > 0) return;

    const defaultModels: Model[] = [
      {
        id: "gemini-enterprise",
        name: "Gemini Enterprise",
        description: "Google Gemini Enterprise - Advanced AI model for business",
        context_length: 1000000,
        max_tokens: 8192,
        is_public: true,
        enabled: true,
      },
      {
        id: "gemini-business",
        name: "Gemini Business",
        description: "Google Gemini Business - AI model optimized for business use",
        context_length: 1000000,
        max_tokens: 8192,
        is_public: true,
        enabled: true,
      },
    ];

    for (const model of defaultModels) {
      await this.createModel(model);
    }
  }
}
