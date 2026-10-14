# 04 · 依赖关系

## 1. 依赖总览

```text
deepseek-harness-codex-auth
├── (运行时 npm)  undici ^8.11.2          ── ProxyAgent + fetch（代理刷新/探测）
├── (宿主注入)    credentials 服务         ── index.js inject
├── (宿主注入)    webServer 服务           ── index.js 可选注入，注册 /api/codex-pool
├── (宿主注入)    slots / configForms      ── client.js inject
├── (宿主注入)    react / react/jsx-runtime ── client.js factory 的 require
├── (宿主提供)    llm-pi-ai 适配器          ── 通过 cordis.patch.yml 扩展
└── (可选补丁)    @deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2 ── 提供 proxyUrl + fetch 注入点
```

**要点**：除 `undici` 外，几乎所有能力都来自宿主运行时注入，而不是 npm 依赖。因此本包
`dependencies` 只有一项，`node_modules` 里也只有 `undici`。

## 2. npm 运行时依赖

| 包 | 版本 | 用途 | 使用位置 |
| --- | --- | --- | --- |
| `undici` | `^8.11.2` | 提供 `ProxyAgent`（HTTP(S) 转发代理 dispatcher）与 `fetch` | [index.js](../index.js#L2) 的 `requesterFor()` |

- 仅**配置了 `proxyUrl` 且未注入 `fetchImpl`** 时才构造 `ProxyAgent`；
- 令牌刷新与主动额度探测都经 `requesterFor()`，因此**共用同一代理出口**；
- 用完立即 `dispatcher.close()`，不做长期连接复用；
- 无代理场景直接使用 `globalThis.fetch`，不引入 undici。

> 注意：[patch](#5-补丁patch详解) 让官方 `@deepseek-ai/dsh-llm-pi-ai` 也 `import "undici"`
> （用于其自身请求路径的代理）。补丁**没有**修改官方包的 `package.json`，该 import 靠本包在
> web profile 里被提升上来的 `undici@8.11.2` 解析——属于隐式依赖，升级后需确认仍可解析。

## 3. 宿主（DeepSeek Harness）提供的依赖

这些不是 npm 依赖，而是通过 Cordis 的 `inject` 声明、由宿主在运行时注入：

| 注入名 | 声明位置 | 提供的能力 | 本插件用法 |
| --- | --- | --- | --- |
| `credentials` | [index.js](../index.js#L31) | 凭据服务 | 覆盖 `resolve` / `describe` |
| `webServer` | [index.js](../index.js#L297) | 通用 HTTP 路由表 | `ctx.inject(["webServer"], …)` 注册 `/api/codex-pool`；缺失时跳过 |
| `slots` | [client.js](../client.js) | UI 槽位系统 | `slots.inject("settings.models.provider-card", …)` |
| `configForms` | [client.js](../client.js) | 配置表单服务 | `get("llm-pi-ai")`、`whileServed`、`form.mutate` |
| `react`, `react/jsx-runtime` | [client.js](../client.js) 的 `require` | React 运行时 | 手写 `jsx` / `jsxs` 渲染卡片 |
| `codexMultiAuth` | 本插件 `ctx.provide()` | 池观测层 | 由**补丁后的** `llm-pi-ai` 反向查找，用于 `wrapFetch` |

`ctx.inject(["webServer"], cb)` 是**可选作用域注入**：宿主没有 `webServer`（无头组合）时
回调不执行，插件照常加载，只是额度面板显示「不可用」。同理，补丁后的适配器用
`ctx.get("codexMultiAuth")` 查找观测层，返回 `undefined` 时完全退回打补丁前的行为。

浏览器端 `dsh.client.inject` 还声明了对两个官方客户端 UI 包的依赖（见 [package.json](../package.json#L40-L46)）：

| 注入面 | 作用 |
| --- | --- |
| `@deepseek-ai/dsh-client-ui-settings` | 设置页框架 |
| `@deepseek-ai/dsh-client-ui-settings-models` | 模型设置页（提供 `settings.models.provider-card` 槽位） |

## 4. 替换/扩展的宿主组件

| 组件 | 关系 | 说明 |
| --- | --- | --- |
| `llm-pi-ai`（官方适配器） | **保留并扩展** | patch 只 `config.providers` 增加 `openai-codex`，不替换实现；同时 `insert` 本插件 |
| `credentials.resolve` | **包装替换** | 目标引用走账号池逻辑，其余透传；dispose 时还原 |
| `credentials.describe` | **包装替换** | 目标引用报告 `codex-cli` 只读状态；字段集合不变 |
| `webServer` 路由表 | **新增路由** | 注册精确路径 `/api/codex-pool`（`GET` 返回池快照 JSON，`POST` 手动固定账号） |
| `codexMultiAuth` 服务 | **新增服务** | `ctx.provide()` 暴露池观测层，供补丁后的适配器 `ctx.get()` 查找 |

## 5. 补丁（patch）详解

文件：[patches/@deepseek-ai__dsh-llm-pi-ai@0.2.0-rc.2.patch](../patches)

对官方包 `@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2` 的改动：

### `lib/index.js`
1. `import { ProxyAgent, fetch as undiciFetch } from "undici"`；
2. provider profile 的 zod schema 增加 `proxyUrl: z.string()`；
3. 新增 `proxyFetchers` / `proxyFetch(proxyUrl)`：
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
4. 新增 `profileFetch(ctx, profile)` —— **代理决定权留在适配器，观测层包在外面**：
   ```js
   function profileFetch(ctx, profile) {
     const base = profile.proxyUrl === undefined ? undefined : proxyFetch(profile.proxyUrl);
     const rotation = ctx.get("codexMultiAuth");
     if (rotation === undefined) return base;
     return rotation.wrapFetch(base);
   }
   ```
   - 未装本插件（`codexMultiAuth` 不存在）→ 返回 `base`；
   - 无代理且无插件 → 返回 `undefined`，**`fetch` 选项根本不注入**，与打补丁前逐字一致。
5. `profileOptions(profile, reasoning, apiKey, fetchImpl)` 增加
   `...fetchImpl === undefined ? {} : { fetch: fetchImpl }`；
6. 调用点改为传第四参：
   ```js
   ...profileOptions(profile, reasoning, apiKey, this.config.fetchFor?.(profile)),
   ```
7. adapter 构造新增：
   ```js
   fetchFor: (profile) => profileFetch(ctx, profile),
   ```
8. 凭据解析改为把代理透传：
   ```js
   await credentials.resolve(ref, { proxyUrl: profile.proxyUrl })
   ```

### `lib/types/config.d.ts`
- `PiAiProviderProfile` 与配置 schema 的类型均补充 `proxyUrl?: string | null`。

### `package.json`
- **未改动**（补丁只动 `lib/`）。第 1 项的 `import "undici"` 依赖 web profile 中被提升上来的
  `undici@8.11.2`（本包的依赖），属于隐式依赖。

**为什么需要这个补丁**：本插件负责「拿到 token」，但请求经由哪个网络出口由 `llm-pi-ai`
决定。补丁把每 provider 的 `proxyUrl` 一路传到 pi-ai 的 `fetch` 选项，并在 `resolve` 时
把同一 `proxyUrl` 交给本插件，从而让**令牌刷新、额度探测与模型请求走同一个代理**。

**分层顺序**（由内到外）：

```text
模型请求 → wrapFetch(观测) → proxyFetch(代理/直连) → undici/globalThis.fetch → 网络
```

观测层永远在最外层，只读响应；即使它完全不工作，请求路径也与未打补丁时一致。

### 补丁的注册与升级

补丁不靠手动 `git apply`，而是由 pnpm 托管：`profiles/web/pnpm-workspace.yaml` 的
`patchedDependencies` 以 `@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2` 为 key 指向补丁文件，
lockfile 的 `patch_hash` 记录其内容；`pnpm install` 与 `dsh plugin add` 都会重放它。

由此带来两个约束：

- **key 与版本强绑定**。官方包升到新版本后 key 不再匹配，pnpm 既不报错也不应用，补丁静默
  失效 —— 这正是额度面板长时间空白、却看不出根因的原因。
- 版本变更后需要：重命名补丁文件、更新 `patchedDependencies` 的 key、按上表重做改动、
  执行 `pnpm install --no-frozen-lockfile`。**完整步骤与锚点见
  [README · 官方包补丁与升级适配](../README.md#官方包补丁与升级适配)。**

另外注意补丁的落点：磁盘上有多份 `dsh-llm-pi-ai`，运行时生效的是 web profile 私有层
`profiles/web/node_modules/@deepseek-ai/dsh-llm-pi-ai`，校验必须针对这一份。

运行时还有一条判据：本插件通过 `/api/codex-pool` 的 `integration` 字段上报补丁是否生效
（见 [03-api-reference.md](./03-api-reference.md#integration)）。

## 6. 版本约束与兼容性

| 项 | 约束 | 原因 |
| --- | --- | --- |
| Node.js | `>=22.19.0` | `AbortSignal.timeout`、原生 `fetch`、`Buffer` `base64url`、内置 `node:test` |
| DeepSeek Harness | `>= 0.2.0-rc.2` | `credentials.resolve(ref, options)` 需支持第二参 `proxyUrl`；`configForms` / 槽位 API |
| `undici` | `^8.11.2` | `ProxyAgent` API |
| 补丁目标包 | 精确 `@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2` | patch 以该版本的文件内容为基准；版本变更后需重做补丁并更新 `patchedDependencies` 的 key，见 [README](../README.md#官方包补丁与升级适配) |
| `@deepseek-ai/dsh-host-webserver` | 提供 `webServer` 服务 | 额度面板的数据通道；缺失时面板降级为「不可用」，不影响核心功能 |

## 7. 依赖流向小结

- **令牌读取/刷新链路**：`llm-pi-ai` → `credentials.resolve(ref, { proxyUrl })` →（本插件
  账号池）→ `<账号>/auth.json` →（可选 `undici.ProxyAgent`）→ `auth.openai.com`。
- **额度观测链路（被动）**：模型响应 → `wrapFetch` → `observe()` → `pool.tokens` 反查账号
  → `recordOutcome()` 合并 `x-codex-*` 响应头。
- **额度观测链路（主动）**：`claim()` → `probeAccount()` →（同一 `ProxyAgent`）→
  `chatgpt.com/backend-api/wham/usage` → `recordQuota()`。
- **启动预热链路**：`apply()` → `void service.warm()` → `discoverAccounts()` → `warmPool()`
  （立即列出账号，无需模型请求）→ `quotaProbe` 打开时 `probeAll(accounts, settings.proxyUrl)`
  →（配置了 `proxyUrl` 则同一 `ProxyAgent`，否则直连）→ `recordQuota()`；
  若 provider 的代理与此不同，首个 `resolve()` 会经 `noteProbeProxy()` 对未测得账号补探一次。
- **配置/UI 链路**：DSH 设置页 → `configForms("llm-pi-ai")` → `client.js`
  → `ProxyField` 写 `providers["openai-codex"].proxyUrl`（被补丁后的 `llm-pi-ai` 读取并生效）
  ／ `QuotaPanel` 读同源 `GET /api/codex-pool`（由 `webServer` 路由返回池快照）。
- **手动固定链路**：面板按钮 → `POST /api/codex-pool { pin }` → `service.pin()` →
  `setPinned(pool, id)` → 下一次 `selectAccount()` 优先返回被固定账号 → 响应体（新快照）回到面板。
  只改 `pool.pinned`，不碰配置、不落盘、不经过补丁。
- **补丁自检链路**：补丁 → `profileFetch` → `service.wrapFetch()` → `integration.hooked`；
  原版适配器 → `credentials.resolve(ref)`（不带 options）→ `integration.stockAdapter`。
  两者随 `GET /api/codex-pool` 下发，面板据此区分「还没请求过」与「补丁没生效」。