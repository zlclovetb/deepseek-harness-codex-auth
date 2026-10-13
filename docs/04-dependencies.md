# 04 · 依赖关系

## 1. 依赖总览

```text
deepseek-harness-codex-auth
├── (运行时 npm)  undici ^8.11.2          ── ProxyAgent + fetch（代理刷新）
├── (宿主注入)    credentials 服务         ── index.js inject
├── (宿主注入)    slots / configForms      ── client.js inject
├── (宿主注入)    react / react/jsx-runtime ── client.js factory 的 require
├── (宿主提供)    llm-pi-ai 适配器          ── 通过 cordis.patch.yml 扩展
└── (可选补丁)    @deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2 ── 提供 proxyUrl 支持
```

**要点**：除 `undici` 外，几乎所有能力都来自宿主运行时注入，而不是 npm 依赖。因此本包
`dependencies` 只有一项，`node_modules` 里也只有 `undici`。

## 2. npm 运行时依赖

| 包 | 版本 | 用途 | 使用位置 |
| --- | --- | --- | --- |
| `undici` | `^8.11.2` | 提供 `ProxyAgent`（HTTP(S) 转发代理 dispatcher）与 `fetch` | [index.js](../index.js#L5) 的 `resolveCodexCredential` |

- 仅在**配置了 `proxyUrl` 且未注入 `fetchImpl`** 时才构造 `ProxyAgent`；
- 刷新结束后立即 `dispatcher.close()`，不做长期连接复用；
- 无代理场景直接使用 `globalThis.fetch`，不引入 undici。

> 注意：[patch](#4-补丁-patch-chan) 让官方 `@deepseek-ai/dsh-llm-pi-ai` 也依赖 `undici`，
> 用于其自身请求路径的代理；该依赖记录在**被补丁的官方包**的 `package.json` 里，不属于本包。

## 3. 宿主（DeepSeek Harness）提供的依赖

这些不是 npm 依赖，而是通过 Cordis 的 `inject` 声明、由宿主在运行时注入：

| 注入名 | 声明位置 | 提供的能力 | 本插件用法 |
| --- | --- | --- | --- |
| `credentials` | [index.js](../index.js#L8) | 凭据服务 | 覆盖 `resolve` / `describe` |
| `slots` | [client.js](../client.js) | UI 槽位系统 | `slots.inject("settings.models.provider-card", …)` |
| `configForms` | [client.js](../client.js) | 配置表单服务 | `get("llm-pi-ai")`、`whileServed`、`form.mutate` |
| `react`, `react/jsx-runtime` | [client.js](../client.js) 的 `require` | React 运行时 | 手写 `jsx` / `jsxs` 渲染 `ProxyField` |

浏览器端 `dsh.client.inject` 还声明了对两个官方客户端 UI 包的依赖（见 [package.json](../package.json#L40-L46)）：

| 注入面 | 作用 |
| --- | --- |
| `@deepseek-ai/dsh-client-ui-settings` | 设置页框架 |
| `@deepseek-ai/dsh-client-ui-settings-models` | 模型设置页（提供 `settings.models.provider-card` 槽位） |

## 4. 替换/扩展的宿主组件

| 组件 | 关系 | 说明 |
| --- | --- | --- |
| `llm-pi-ai`（官方适配器） | **保留并扩展** | patch 只 `config.providers` 增加 `openai-codex`，不替换实现；同时 `insert` 本插件 |
| `credentials.resolve` | **包装替换** | 目标引用走 Codex 逻辑，其余透传；dispose 时还原 |
| `credentials.describe` | **包装替换** | 目标引用报告 `codex-cli` 只读状态 |

## 5. 补丁（patch）详解

文件：[patches/@deepseek-ai__dsh-llm-pi-ai@0.2.0-rc.2.patch](../patches)

对官方包 `@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2` 的改动：

### `lib/index.js`
1. `import { ProxyAgent, fetch as undiciFetch } from "undici"`；
2. provider profile 的 zod schema 增加 `proxyUrl: z.string()`；
3. 新增：
   ```js
   const proxyFetchers = new Map();
   function proxyFetch(proxyUrl) {
     let fetcher = proxyFetchers.get(proxyUrl);
     if (fetcher !== undefined) return fetcher;
     const url = new URL(proxyUrl);
     if (url.protocol !== "http:" && url.protocol !== "https:")
       throw new Error(`llm-pi-ai proxyUrl only supports HTTP(S): ${url.protocol}`);
     const dispatcher = new ProxyAgent(url);
     fetcher = (input, init) => undiciFetch(input, { ...init, dispatcher });
     proxyFetchers.set(proxyUrl, fetcher);
     return fetcher;
   }
   ```
   —— 每个代理 URL **缓存一个** dispatcher（注释说明：出现活跃代理切换需求时再加淘汰）。
4. `profileOptions()` 中：
   ```js
   ...profile.proxyUrl === undefined ? {} : { fetch: proxyFetch(profile.proxyUrl) },
   ```
5. 凭据解析调用改为把代理透传：
   ```js
   await credentials.resolve(ref, { proxyUrl: profile.proxyUrl })
   ```

### `lib/types/config.d.ts`
- `PiAiProviderProfile` 与配置 schema 的类型均补充 `proxyUrl?: string | null`。

### `package.json`
- `dependencies` 增加 `"undici": "^8.11.2"`。

**为什么需要这个补丁**：本插件负责“拿到 token”，但请求经由哪个网络出口由 `llm-pi-ai`
决定。补丁把每 provider 的 `proxyUrl` 一路传到 pi-ai 的 `fetch` 选项，并在 `resolve` 时
把同一 `proxyUrl` 交给本插件，从而让**令牌刷新与模型请求走同一个代理**。

## 6. 版本约束与兼容性

| 项 | 约束 | 原因 |
| --- | --- | --- |
| Node.js | `>=22.19.0` | `AbortSignal.timeout`、原生 `fetch`、`Buffer` `base64url`、内置 `node:test` |
| DeepSeek Harness | `>= 0.2.0-rc.2` | `credentials.resolve(ref, options)` 需支持第二参 `proxyUrl`；`configForms` / 槽位 API |
| `undici` | `^8.11.2` | `ProxyAgent` API |
| 补丁目标包 | 精确 `@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2` | patch 以该版本的文件内容为基准，版本不匹配会打不上 |

## 7. 依赖流向小结

- **令牌读取/刷新链路**：`llm-pi-ai` → `credentials.resolve` →（本插件）→ `auth.json`
  →（可选 `undici.ProxyAgent`）→ `auth.openai.com`。
- **配置/UI 链路**：DSH 设置页 → `configForms("llm-pi-ai")` → `client.js ProxyField`
  → 写 `providers["openai-codex"].proxyUrl` → 被补丁后的 `llm-pi-ai` 读取并生效。