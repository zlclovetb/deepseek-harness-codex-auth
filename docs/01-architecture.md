# 01 · 整体架构

## 1. 背景与目标

DeepSeek Harness（以下简称 DSH）通过官方 `llm-pi-ai` 适配器接入各模型 provider。每个 provider
路由通过 `apiKeyEnv` 字段声明**凭据引用名**，运行时由 DSH 的 `credentials` 服务解析出实际密钥。

Codex CLI 已经在 `$CODEX_HOME/auth.json` 中保存了 ChatGPT 的 OAuth 令牌。本插件的目标：

> 让 `llm-pi-ai` 的 `openai-codex` 路由把 `OPENAI_CODEX_AUTH` 这一引用解析为 Codex CLI 的
> **实时 access token**，token 始终留在 Codex 自己的文件里，不复制、不落库。

## 2. 组件拓扑

```text
┌──────────────────────────────────────────────────────────────────┐
│                        DeepSeek Harness 宿主                       │
│                                                                    │
│  ┌────────────────┐   resolve("OPENAI_CODEX_AUTH")   ┌──────────┐  │
│  │  llm-pi-ai     │ ───────────────────────────────▶ │credentials│ │
│  │ (官方适配器)    │                                  │  service  │ │
│  └────────────────┘                                  └────┬─────┘ │
│         ▲  路由 openai-codex                              │ 被本插件 │
│         │  apiKeyEnv=OPENAI_CODEX_AUTH                    │ 打桩覆盖 │
│         │                                                 ▼        │
│  ┌──────┴─────────┐                            ┌──────────────────┐│
│  │ Cordis 插件系统 │── insert ────────────────▶ │ codex-cli-auth   ││
│  │ (cordis.patch) │                            │  (index.js apply)││
│  └────────────────┘                            └────────┬─────────┘│
│                                                          │ 读写      │
│  ┌────────────────────┐        configForms / slots       ▼          │
│  │ Web UI 设置页        │◀──── client.js ProxyField ──▶ $CODEX_HOME/ │
│  │ (provider-card)     │                                 auth.json  │
│  └────────────────────┘                                     │       │
└─────────────────────────────────────────────────────────────┼──────┘
                                                              │ HTTPS
                                                    ┌─────────▼─────────┐
                                                    │ auth.openai.com   │
                                                    │ /oauth/token 刷新 │
                                                    └───────────────────┘
```

三个协作面：

| 面 | 载体 | 作用 |
| --- | --- | --- |
| **认证桥**（服务端） | [index.js](../index.js) | 覆盖 `credentials.resolve/describe`，解析并刷新 Codex token |
| **路由注入**（配置） | [cordis.patch.yml](../cordis.patch.yml) | 给 `llm-pi-ai` 挂 `openai-codex` 路由 + 插入本插件 |
| **设置 UI**（浏览器端） | [client.js](../client.js) | 在模型页 provider 卡片注入“网络代理”输入框 |
| **代理能力**（补丁） | [patches/…pi-ai@0.2.0-rc.2.patch](../patches) | 给官方包增加 `proxyUrl` 支持与 `fetch` 注入 |

## 3. 运行时数据流（一次模型请求的凭据解析）

1. `llm-pi-ai` 要发请求，调用 `credentials.resolve("OPENAI_CODEX_AUTH", { proxyUrl })`。
2. 本插件替换后的 `resolve` 判断引用名匹配 → 调用 `resolveCodexCredential({ proxyUrl })`。
3. `readAuth()` 读取并校验 `auth.json`（必须有 `tokens.access_token` 与 `tokens.refresh_token`）。
4. `expiresAt()` 解析 JWT 的 `exp`：
   - 若 `exp > now + 5min` → 直接返回现有 access token（**零网络开销**）。
   - 否则进入刷新分支。
5. 刷新分支使用模块级 `refreshInflight` 单例，**并发去重**：
   - 只发起一次 `POST https://auth.openai.com/oauth/token`；
   - 若指定了 `proxyUrl`，构造 `undici.ProxyAgent` 作为 dispatcher；
   - 完成后 `close()` dispatcher 并清空 `refreshInflight`。
6. 刷新成功后再读一次磁盘（`latest`），只有 `refresh_token` 未被他人替换时才写回，
   避免与 Codex CLI 本身并发刷新互相覆盖（乐观并发控制）。
7. 返回 `{ value: <access token>, source: "codex-cli" }` 给 `llm-pi-ai`。

## 4. 插件生命周期

```text
DSH 启动
  └─ 应用 cordis.patch.yml
        ├─ 修改 llm-pi-ai 配置：新增 openai-codex provider（apiKeyEnv=OPENAI_CODEX_AUTH）
        └─ insert 插件 id=codex-cli-auth（模块 deepseek-harness-codex-auth）
              └─ index.js: apply(ctx)
                    ├─ ctx.get("credentials") 取到宿主凭据服务
                    ├─ 保存原始 resolve / describe
                    ├─ 用包装函数替换它们
                    └─ 返回 dispose 函数（卸载时还原原始方法）

浏览器端（Web profile）
  └─ client.js: window.__ModuleLoader__.load({...})
        └─ apply(ctx)
              └─ 在 settings.models.provider-card 注入 ProxyField（仅 openai-codex 显示）
```

## 5. 关键设计约束

- **单一引用拦截**：只处理 `OPENAI_CODEX_AUTH`，其它引用一律透传给原始实现，
  保证与 DSH 其它凭据（环境变量、Harness 凭据库）互不干扰。
- **token 不落地**：access/refresh token 不复制进 Harness 配置或凭据文件，始终以
  `auth.json` 为唯一事实来源。
- **只读凭据语义**：`describe()` 对 `OPENAI_CODEX_AUTH` 返回 `writable: false`，
  告知 UI 该凭据不可由 Harness 编辑（只能通过 `codex login` 修改）。
- **原子写回**：`writeAuth()` 先写同目录临时文件再 `rename`，并设 `mode: 0o600`，
  避免半写状态与宽权限。
- **并发安全**：`refreshInflight` 去重同进程刷新；写回前的 `refresh_token` 比对，
  处理跨进程（Codex CLI ↔ Harness）竞态。
- **明确失败**：读不到文件、缺少 tokens、刷新 HTTP 失败或返回体不含 token 时抛出带
  可操作提示的错误（`run "codex login"`），不做静默降级。
- **文件型凭据限定**：当前仅支持文件型 `auth.json`；若 Codex 仅使用系统钥匙串，
  插件会明确报错而非猜测。

## 6. 边界与不支持项

- 不复用/导入 Codex 的历史对话，只复用登录凭据。
- 不支持非文件型存储（系统钥匙串）。
- 代理（`proxyUrl`）依赖官方包补丁；未打补丁时该字段不生效（见 [04-dependencies.md](./04-dependencies.md)）。
- 本插件为**本机可信插件**：它与 Codex CLI 共享 refresh token，不应安装到不可信 profile。