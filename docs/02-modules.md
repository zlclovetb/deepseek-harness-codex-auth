# 02 · 模块职责

## 目录结构

```text
deepseek-harness-codex-auth/
├── index.js                 # 服务端插件入口：认证桥 + 账号池装配 + 额度 HTTP 路由
├── lib/
│   ├── accounts.js          # 账号发现、auth.json 读写、token→账号身份
│   ├── quota.js             # 额度响应头解析、窗口合并与过期
│   ├── rotation.js          # 池状态：健康分、冷却、选择策略、快照
│   └── probe.js             # 主动额度探测（chatgpt.com/backend-api/wham/usage）
├── client.js                # 浏览器端插件：设置页「网络代理」+「多账号额度」
├── cordis.patch.yml         # Bundle patch：openai-codex 路由 + 插入本插件 + 池参数
├── patches/
│   └── @deepseek-ai__dsh-llm-pi-ai@0.2.0-rc.2.patch   # 给官方包增加 proxyUrl/fetch 注入点
├── test/
│   ├── auth.test.js         # 认证桥单测（4 例）
│   └── pool.test.js         # 账号池 / 额度 / 轮换 / 预热单测（13 例）
├── package.json             # 包元数据 + dsh bundle/client 声明
├── package-lock.json        # 依赖锁（undici）
├── README.md                # 面向使用者的说明
├── LICENSE                  # MIT
└── docs/                    # 本 Wiki
```

---

## index.js — 服务端 / 认证桥 + 账号池装配

**职责**：作为 Cordis 插件接管 `credentials` 服务中对 `OPENAI_CODEX_AUTH` 的解析与描述，
把单文件解析升级为**账号池选择**，并把池状态以服务 + HTTP 两种形式暴露出去。

**导出符号**

| 导出 | 类型 | 说明 |
| --- | --- | --- |
| `name` | `string` | Cordis 插件名 `"codex-cli-auth"` |
| `inject` | `string[]` | `["credentials"]`，声明依赖宿主凭据服务 |
| `CODEX_CREDENTIAL_REF` | `string` | 被拦截的引用名 `"OPENAI_CODEX_AUTH"` |
| `ROTATION_SERVICE` | `string` | `"codexMultiAuth"`，补丁后的适配器用它查找观测层 |
| `QUOTA_ROUTE` | `string` | `"/api/codex-pool"`，客户端轮询的精确路由 |
| `resolveCodexCredential(opts)` | `async function` | 单文件解析（必要时刷新），签名与旧版一致 |
| `apply(ctx, config)` | `function` | 插件入口，装配池、打桩 `credentials`、注册路由，返回 dispose |
| `DEFAULT_STRATEGY` | `string` | 从 `lib/rotation.js` 重新导出 |

**内部结构（分区）**

- **配置区**：`configValue()`（兼容 plain/reactive 配置）、`readSettings()`（读
  `accountsDir` / `quotaProbe` / `proxyUrl` / `rotateOnQuotaExhausted` / `strategy`，`rotateOnQuotaExhausted === false`
  时把策略降级为 `"sticky"`）。
- **常量区**：`CLIENT_ID`、`REFRESH_URL`、`REFRESH_WINDOW_MS`、`PROBE_MAX_AGE_MS`（10 分钟）、
  模块级 `refreshInflight`（按文件路径去重）。
- **传输与令牌**：`requesterFor()`、`refresh()`、`tokenFor()`、`bearerFrom()`、`resolveCodexCredential()`。
- **池服务**：`createService({ settings, pool })` → `{ resolve, observe, wrapFetch, snapshot, integration, noteAdapterRequest, warm, pin, … }`（内部还有 `probeAll()` 与 `probedProxy`，见 [03](./03-api-reference.md#createService-settings-pool)）。
- **装配**：`anyConfigured()`、`apply()`（创建服务后立刻 `void service.warm()` 后台预热池）、`registerQuotaRoute()`。

详见 [03-api-reference.md](./03-api-reference.md)。

---

## lib/accounts.js — 账号发现与文件读写

**职责**：把「磁盘上有哪些 Codex 登录」这件事收敛成一处。

- `codexHome(env)` / `legacyAuthPath(env)`：`$CODEX_HOME`（默认 `~/.codex`）与其中的 `auth.json`。
- `resolveAccountsDir({ accountsDir, env })`：优先级 显式配置 → `CODEX_ACCOUNTS_DIR` → `$CODEX_HOME/accounts`。
- `decodeAccessToken(token)` / `expiresAt(token)`：JWT payload 解析与过期时间。
- `accountIdentity(auth)`：`payload["https://api.openai.com/auth"].chatgpt_account_id`
  → `auth.tokens.account_id` → `payload.sub`，用于主动探测的 `chatgpt-account-id` 头。
- `readAccountAuth(path)` / `writeAccountAuth(path, auth)`：校验式读取（错误文案与旧版一致）与
  原子写回（临时文件 + `rename`，`mode 0o600`）。
- `discoverAccounts({ accountsDir, env })`：返回 `{ dir, pooled, accounts }`；
  有子目录则 `pooled: true`（按 id 排序），否则回退单账号 `{ id: "default", path: legacyAuthPath() }`。
- `accountLabel(entry, auth)`：展示用标签。

---

## lib/quota.js — 额度解析

**职责**：把 Codex 的额度响应头变成可比较、可过期的窗口对象。

- `parseQuota(headers, now)`：读 `x-codex-primary-used-percent`（5 小时）、
  `x-codex-secondary-used-percent`（本周）、`…-reset-at` / `…-reset-after-seconds` / `…-window-minutes`。
  reset 支持 epoch 秒、epoch 毫秒、ISO 字符串，缺省回退 `reset-after-seconds`。
- `mergeQuota(previous, next)` / `expireWindows(quota, now)`：合并新读数、把已过期的窗口归零。
- `hasQuota()` / `peakUsedPercent()` / `isQuotaExhausted()`（任一窗口 ≥ 100%）/ `quotaRetryAt()`。
- `readHeader(headers, name)`：兼容 `Headers` 实例与普通对象。

---

## lib/rotation.js — 池状态与选择

**职责**：进程内的账号状态机：谁可用、谁冷却、下一个用谁。

- 常量：`STRATEGIES = ["hybrid","round-robin","sticky"]`、`DEFAULT_STRATEGY = "hybrid"`、
  `DEFAULT_COOLDOWN_MS = 15min`、`TRANSPORT_COOLDOWN_MS = 30s`、`normalizeStrategy()`。
- `createPool()` / `prunePool()` / `entryState()`：池与账号状态的生命周期；`prunePool()`
  同时清掉已消失账号留下的 `sticky` 与 `pinned`。
- `warmPool(pool, entries)`：给发现的每个账号建立状态条目，让面板在**首个请求之前**就能列出账号
  —— 只建条目，不选中（不写 `lastUsedAt`）、不造额度读数。
- `noteToken()` / `accountForToken()`：token ↔ 账号归因（响应观测的前提）。
- `isAvailable()` / `retryAt()` / `hybridOrder()`：可用性判定与排序
  （`剩余额度百分比 × 健康分` 降序，`lastUsedAt` 破平）。
- `selectAccount(pool, entries, { now })`：**先看手动固定**（`pool.pinned`，命中且可用即返回），
  否则按策略选择；全部不可用时返回最早恢复者，以便上层报出真实的重置时间而不是「池为空」。
  **自身不做 prune**，避免误删未传入的账号状态。
- `setPinned(pool, id)`：设置/清除手动固定（`null` 或空串即清除），返回生效值。
- `markUsed()` / `markCooldown()` / `quotaStale()` / `recordQuota()` / `recordOutcome()`：
  状态写入。`recordOutcome` 在 429 时**不扣健康分**（额度窗口已表达限流），只记失败与冷却；
  5xx 健康分 ×0.7 且短冷却；2xx–3xx 健康分回升并清冷却。
- `poolSnapshot(pool, now)`：给 `/api/codex-pool` 用的可序列化视图。

---

## lib/probe.js — 主动额度探测

**职责**：在把请求交给某账号前，主动读一次它的额度。

- `USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"`。
- `parseUsage(payload, now)`：递归收集含 `used_percent` 的对象，按 `windowSeconds` 升序
  分成 primary（短窗）/ secondary（长窗），输出与 `parseQuota` 同形状。
- `probeQuota({ token, accountId, fetchImpl, refresh, url, now })`：GET，
  头为 `accept` / `authorization` / `chatgpt-account-id`，15 秒超时；
  401 且提供了 `refresh` 时刷新一次再重试；任何失败/非 2xx/解析异常一律返回 `undefined`
  （探测是增强，不是依赖）。

---

## client.js — 浏览器端模块

**职责**：在 Web 设置页的「模型 → provider 卡片」区域，为 `openai-codex` 卡片注入
「网络代理」输入框与「多账号额度」面板。

**形态**：不是普通 ESM 模块，而是通过宿主提供的 `window.__ModuleLoader__.load({ id, factory })`
注册的浏览器端模块。`factory(require)` 内用 `require("react")` / `require("react/jsx-runtime")`
（由宿主注入 React，而非 npm 解析）。

**导出**：`module.exports = { apply, inject }`，其中 `inject = ["slots", "configForms"]`。

**`ProxyField`（沿用）**

- 仅当 `provider.provider === "openai-codex"` 时渲染；
- `React.useSyncExternalStore(form.subscribe, form.getSnapshot)` 订阅表单快照；
- 保存走 `form.mutate([{ op: "set" | "unset", path: ["providers","openai-codex","proxyUrl"] }])`；
- `validProxyUrl()` 仅接受 `http:` / `https:`，否则报错并禁用保存。

**`QuotaPanel`（新增）**

- 同样只作用于 `openai-codex` 卡片；
- 每 **15 秒** `fetch("/api/codex-pool")`（与设置页同源，无需额外鉴权面）；
- 网络失败时保留最后一次读数，并把角标降级为「已断开」；从未成功过则提示
  「多账号额度不可用（当前运行环境未提供 Web 接口）」；
- 账号列表为空时先看 `snapshot.integration`：`hooked === false && stockAdapter === true`
  说明补丁未生效，显示告警「额度观测未生效：当前 llm-pi-ai 未适配本插件……」；
  否则提示「尚未列出账号：账号目录仍在读取，或未发现任何登录……」。池在插件装配时就已后台预热
  （见 [`warm()`](./03-api-reference.md#warm)），因此正常情况下列表随设置页打开即出现，
  这条提示只在预热尚未完成或 `accountsDir` 下确无登录时短暂可见；
- 每个账号渲染 5 小时 / 本周两条进度条（`--dsw-alias-bg-layer-2` 作轨道，
  `--dsw-alias-state-success/warn/error-primary` 表示 <80% / ≥80% / ≥100%），
  行首为账号 id 与「当前」标记（取 `lastUsedAt` 最大者），行内 meta 为
  「上次使用 N 分钟前 / 尚未使用」及健康状况，尾部是可用性角标与重置倒计时。
- **手动固定**：行尾按钮「用此账号」/「取消固定」`POST` 同一路由
  `{ pin: "<id>" | null }`，标题栏在已固定时出现「恢复自动」；`POST` 的响应体就是新的池快照，
  直接顶替轮询读数，不必等下一个 15 秒。失败显示「切换账号失败，请重试」。
  固定账号不可用时（`snapshot.pinned` 有值但该账号 `available === false`）额外提示
  「已临时回退到自动选择」，避免把兜底误读成切换无效。

**`CodexProviderCard`**：组合 `ProxyField` + `QuotaPanel`，并统一做 `openai-codex` 判断。

**`apply(ctx)`**：`ctx.configForms.get("llm-pi-ai")`，
`ctx.configForms.whileServed(["llm-pi-ai"], …)` 内 `ctx.slots.inject("settings.models.provider-card", …)`
注册 `CodexProviderCard`。

详见 [03-api-reference.md](./03-api-reference.md#clientjs)。

---

## cordis.patch.yml — Bundle patch

**职责**：插件安装时对 Harness 配置做增量修改（Cordis bundle patch 语义）。

**内容**：

1. **修改既有插件 `llm-pi-ai`**：在 `config.providers` 下新增 provider：
   ```yaml
   openai-codex:
     displayName: OpenAI Codex (Codex CLI login)
     apiKeyEnv: OPENAI_CODEX_AUTH
   ```
   —— 复用官方适配器，不替换它，只是补一条走 Codex 凭据的路由。

2. **insert 本插件**，并带上池参数：
   ```yaml
   - id: codex-cli-auth
     name: deepseek-harness-codex-auth
     config:
       strategy: hybrid
       quotaProbe: false
       rotateOnQuotaExhausted: true
       # accountsDir: "C:/Users/me/.codex/accounts"
   ```
   —— `accountsDir` 留空即用默认 `$CODEX_HOME/accounts`。`quotaProbe: true` 时，插件除了在
   交出请求前探测，还会在**启动预热**时（以及首次拿到 `proxyUrl` 后）主动读一次各账号额度，
   让面板无需等待首个模型请求就能显示用量。provider 走代理时，这里也要填同样的 `proxyUrl`
   （`# proxyUrl: "http://127.0.0.1:7890"`），否则启动探测只能直连、在需要代理的网络里必然失败。

---

## patches/@deepseek-ai__dsh-llm-pi-ai@0.2.0-rc.2.patch — 官方包补丁

**职责**：为官方 `@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2` 增加**每 provider 独立代理**支持，
并留出额度观测的 `fetch` 注入点。

**改动点**（详见 [04-dependencies.md](./04-dependencies.md#5-补丁patch详解)）：

1. `lib/index.js`
   - 引入 `undici` 的 `ProxyAgent` / `fetch`；
   - `profile` schema 增加 `proxyUrl`；
   - 新增 `proxyFetchers` / `proxyFetch(proxyUrl)`：按 URL 缓存 `ProxyAgent`；
   - 新增 `profileFetch(ctx, profile)`：`base = proxyUrl ? proxyFetch(proxyUrl) : undefined`，
     再取 `ctx.get("codexMultiAuth")`，有则 `rotation.wrapFetch(base)`——**没有插件时返回
     `undefined`，与打补丁前完全一致**；
   - `profileOptions()` 支持注入 `fetch`；调用点改为
     `profileOptions(profile, reasoning, apiKey, this.config.fetchFor?.(profile))`；
   - adapter 配置新增 `fetchFor: (profile) => profileFetch(ctx, profile)`；
   - `resolveApiKey` 改为 `credentials.resolve(ref, { proxyUrl: profile.proxyUrl })`。
2. `lib/types/config.d.ts`：补充 `proxyUrl` 类型声明。
3. `package.json`：**未改动** —— 补丁只动 `lib/`，其 `import "undici"` 依赖 web profile 中被
   提升上来的 `undici@8.11.2`（本包依赖），属于隐式依赖。

**条件性**：这是可选增强。未打补丁时插件主体（token 桥 + 池）仍工作，
只是没有「网络代理」字段，也没有被动额度观测路径（主动探测仍可用）。

**版本绑定**：补丁由 pnpm 的 `patchedDependencies` 托管，key 精确到
`@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2`。官方包升到新版本后 key 不再匹配，pnpm **既不报错也不
应用** —— 补丁静默失效。另外磁盘上存在多份 `dsh-llm-pi-ai`（CLI 安装树、`profiles/node_modules`
共享层、`profiles/web/node_modules` 私有层），运行时生效的是 web profile 私有层那份，补丁必须
落在它上面。升级适配与校验步骤见 [README · 官方包补丁与升级适配](../README.md#官方包补丁与升级适配)。

**失效自检**：面板不靠猜文件路径判断补丁是否生效 —— `wrapFetch` 被调用即置
`integration.hooked`，原版适配器解析凭据时不带 `options` 则置 `integration.stockAdapter`，
两者组合即可区分「还没请求过」与「补丁没生效」（见
[03-api-reference.md](./03-api-reference.md#integration)）。

---

## test/ — 单元测试

`npm test` 运行两个文件，共 **17** 个用例（`node:test` + `node:assert/strict`）。

**test/auth.test.js（4 例，认证桥）**

| 用例 | 验证点 |
| --- | --- |
| `returns a fresh Codex access token without network access` | token 未过期时，**不触发** `fetchImpl` |
| `refreshes an expiring token and preserves the Codex auth document` | 过期时刷新；校验请求体；写回后保留其它字段并更新 `last_refresh` |
| `only intercepts the dedicated credential reference` | 非目标引用透传；`dispose()` 还原 `resolve/describe` |
| `reports the live Codex login as a configured read-only credential` | `describe` 返回 `writable: false` |

**test/pool.test.js（13 例，账号池）**

| 用例 | 验证点 |
| --- | --- |
| 空 `accounts/` 目录回退 legacy | 单账号兼容路径 |
| 子目录成池并排序 | `discoverAccounts` 的排序与 id |
| quota 响应头归一到两个窗口 | `parseQuota` |
| hybrid 偏好有余额账号并跳过限流账号 | `selectAccount` |
| 窗口重置后账号重回轮换 | `expireWindows` + `isAvailable` |
| 固定账号优先于策略，清除后回到策略 | `setPinned` + `selectAccount` |
| 固定账号耗尽时让位、窗口重置后回归 | 兜底语义 |
| 账号消失时固定被丢弃 | `prunePool` 清理 `pinned` |
| `warmPool` 列出全部账号但不选中 | 预热不写 `lastUsedAt` / 不造额度 |
| `apply()` 在首个请求前填好池 | 装配时的后台预热 |
| `apply()` 经池解析、由 `observe` 驱动下次切换 | 端到端打桩 |
| `wrapFetch` 观测额度且不改响应 | 响应对象原样返回 |
| 面板经路由固定账号 | `POST /api/codex-pool`（200 / 404 / 405） |

**辅助**：`codexToken(accountId, exp)` 造带 `chatgpt_account_id` 的 JWT，`writePool()` 铺账号目录，
`fakeWebServer()` / `fakeExchange()` 驱动路由，`until()` 等待后台预热等自发异步，以及只实现
`get`/`provide`/`inject` 的假 `ctx`。

---

## package.json — 元数据与宿主约定

**关键字段**

| 字段 | 值 | 作用 |
| --- | --- | --- |
| `type` | `module` | 全包 ESM |
| `main` / `exports["."]` | `index.js` | 服务端入口 |
| `exports["./client"]` | `client.js` | 浏览器端入口 |
| `engines.node` | `>=22.19.0` | 需支持 `AbortSignal.timeout`、`fetch`、`base64url` 等 |
| `dsh.bundle.patch` | `./cordis.patch.yml` | 声明 bundle patch 位置 |
| `dsh.client.platform` | `web` | 浏览器端面向 Web profile |
| `dsh.client.inject` | `dsh-client-ui-settings`, `dsh-client-ui-settings-models` | 客户端 UI 依赖的注入面 |
| `files` | `index.js` `client.js` `lib` `cordis.patch.yml` `patches` `README.md` `LICENSE` | 打包白名单 |

**脚本**

- `npm test` → `node --test`
- `pack:check` → `npm pack --dry-run`