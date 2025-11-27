# Business Gemini Pool - Deno Fresh 版本

基于 Deno Fresh 框架的 Google Gemini Enterprise API 代理服务，提供多账号轮训、OpenAI 兼容接口和完整的管理控制台。

## 功能特性

- **多账号轮训管理**: 使用 Deno KV 实现原子性轮训调度
- **OpenAI 兼容 API**: 支持 `/v1/chat/completions` 和 `/v1/models` 接口
- **流式/非流式响应**: 完整支持 Server-Sent Events (SSE)
- **管理控制台**: 基于 Fresh Islands 的 Web UI
- **图片缓存**: 使用 Deno KV 缓存小图片（<60KB）
- **JWT 自动管理**: 自动获取和缓存 JWT（240秒有效期）
- **会话管理**: 自动创建和复用 Gemini 会话

## 技术栈

- **运行时**: Deno 1.40+
- **框架**: Fresh 1.6+ (Preact-based SSR)
- **数据库**: Deno KV (内置键值存储)
- **CSS**: Tailwind CSS 3.x (CDN)
- **状态管理**: Preact Signals
- **部署**: Deno Deploy

## 快速开始

### 本地运行

1. **安装 Deno** (如果尚未安装)
```bash
curl -fsSL https://deno.land/install.sh | sh
```

2. **生成 fresh.gen.ts**
```bash
cd fresh-gemini-pool
deno task manifest
```

3. **启动开发服务器**
```bash
deno task start
```

4. **访问应用**
- 管理控制台: http://localhost:8000
- 聊天界面: http://localhost:8000/chat
- API 端点: http://localhost:8000/v1/chat/completions

### 部署到 Deno Deploy

1. **安装 deployctl**
```bash
deno install -Arf https://deno.land/x/deploy/deployctl.ts
```

2. **部署到生产环境**
```bash
deployctl deploy --project=your-project-name --prod main.ts
```

3. **配置环境变量**（可选）
在 Deno Deploy 控制台设置：
- `PROXY_URL`: HTTP 代理地址（如需要）

## 使用说明

### 1. 添加账号

首次部署后，访问管理控制台添加 Gemini Enterprise 账号：

1. 点击"添加账号"按钮
2. 填写以下信息：
   - **Team ID**: Google Business 团队 ID
   - **Secure C SES**: Cookie 中的 `__Secure-C_SES` 值
   - **Host C OSES** (可选): Cookie 中的 `__Host-C_OSES` 值
   - **CSESIDX**: 会话索引
   - **User Agent** (可选): 浏览器 User Agent

3. 点击"测试"按钮验证账号可用性

### 2. OpenAI 兼容 API 使用

#### 聊天完成 (Chat Completions)

```bash
curl -X POST https://your-app.deno.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-enterprise",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ],
    "stream": false
  }'
```

#### 流式响应

```bash
curl -X POST https://your-app.deno.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-enterprise",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ],
    "stream": true
  }'
```

#### 列出模型

```bash
curl https://your-app.deno.dev/v1/models
```

### 3. 管理 API

#### 账号管理
- `GET /api/accounts` - 列出所有账号
- `POST /api/accounts` - 创建账号
- `PUT /api/accounts/:id` - 更新账号
- `DELETE /api/accounts/:id` - 删除账号
- `POST /api/accounts/:id/toggle` - 启用/禁用账号
- `POST /api/accounts/:id/test` - 测试账号连接

#### 模型管理
- `GET /api/models` - 列出所有模型
- `POST /api/models` - 创建模型
- `PUT /api/models/:id` - 更新模型
- `DELETE /api/models/:id` - 删除模型

#### 配置管理
- `GET /api/config` - 获取配置
- `PUT /api/config` - 更新配置

#### 系统状态
- `GET /api/status` - 获取系统状态

## 项目结构

```
fresh-gemini-pool/
├── lib/                     # 核心业务逻辑
│   ├── account-manager.ts   # 多账号轮训管理
│   ├── jwt-manager.ts       # JWT 缓存管理
│   ├── session-manager.ts   # 会话管理
│   ├── gemini-api.ts        # Gemini API 封装
│   ├── image-cache.ts       # 图片缓存
│   ├── config-store.ts      # 配置存储
│   └── types.ts             # TypeScript 类型
├── routes/                  # 路由定义
│   ├── index.tsx            # 管理控制台页面
│   ├── chat.tsx             # 聊天界面页面
│   ├── api/                 # 管理 API
│   └── v1/                  # OpenAI 兼容 API
├── islands/                 # 客户端交互组件
│   ├── AccountManager.tsx   # 账号管理界面
│   └── ChatInterface.tsx    # 聊天界面
├── deno.json                # Deno 配置
├── main.ts                  # 应用入口
└── fresh.config.ts          # Fresh 配置
```

## 核心架构

### 多账号轮训调度

使用 Deno KV 的原子操作 (`kv.atomic()`) 和乐观锁实现并发安全的轮训调度：

```typescript
const res = await kv.get<number>(indexKey);
const commitResult = await kv.atomic()
  .check(res)  // 乐观锁
  .set(indexKey, nextIndex)
  .commit();
```

### JWT 缓存策略

- 缓存时间: 240 秒（实际有效期 300 秒）
- 自动刷新: 过期时自动重新获取
- 跨请求共享: 通过 Deno KV 实现

### 图片缓存

- **小图片** (<60KB): 存储到 Deno KV，1小时后自动过期
- **大图片** (>60KB): 返回下载 URL（实时从 Gemini 下载）

## 故障排除

### 账号测试失败

1. 检查 Cookie 值是否正确（`__Secure-C_SES`, `__Host-C_OSES`）
2. 验证 Team ID 和 CSESIDX 是否匹配
3. 如果使用代理，确保代理可访问

### 所有账号都不可用

1. 访问管理控制台查看账号状态
2. 点击"测试"按钮逐个验证
3. 查看不可用原因（401/404 错误）
4. 更新 Cookie 或重新添加账号

### 流式响应不工作

1. 确保客户端支持 Server-Sent Events (SSE)
2. 检查浏览器控制台是否有错误
3. 尝试使用非流式模式 (`stream: false`)

## 安全注意事项

- ⚠️ Cookie 值包含敏感凭证，请勿泄露
- ⚠️ 部署到生产环境时建议添加认证中间件
- ⚠️ 管理 API 默认无认证，建议配置访问控制

## 开发任务

```bash
# 代码检查
deno task check

# 启动开发服务器（热重载）
deno task start

# 生成路由清单
deno task manifest

# 构建生产版本
deno task build

# 运行生产服务器
deno task preview
```

## License

MIT

## 致谢

基于 Flask 版本迁移而来，感谢原项目贡献者。
