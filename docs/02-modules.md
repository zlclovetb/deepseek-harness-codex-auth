# 02 · 模块职责

## 目录结构

```text
deepseek-harness-codex-auth/
├── index.js                 # 服务端插件入口：认证桥 + 账号池装配 + 额度 HTTP 路由
├── lib/
│   ├── accounts.js          # 账号发现、auth.json 读写、token→账号身份
│   ├── quota.js             # 额度响应头解析、窗口合并与过期
│   ├── rotation.js          # 池状态：健康分、冷却、选择策略、快照
│   └── probe.js             # 主动额度读取：订阅优先（…/usage/subscriptions）+ 拉取兜底
├── client.js                # 浏览器端插件：设置页「网络代理」+「多账号额度」
├── cordis.patch.yml         # Bundle patch：openai-codex 路由 + 插入本插件 + 池参数
├── patches/
│   ├── @deepseek-ai__dsh-llm-pi-ai@0.2.1-rc.2.patch   # 给官方包增加 proxyUrl/fetch 注入点（当前宿主）
│   └── @deepseek-ai__dsh-llm-pi-ai@0.2.0-rc.2.patch   # 仅供仍停在 dsh 0.2.0-rc.2 的宿主
├── test/
│   ├── auth.test.js         # 认证桥单测（4 例）
│   ├── pool.test.js         # 账号池 / 额度 / 轮换 / 预热 / 探测重试单测（22 例）
│   └── probe.test.js        # 额度读取：窗口分槽与订阅优先单测（5 例）
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
| `QUOTA_ROUTE` | `string` | `"/api/codex-pool"`，客户端读取的精确路由 |
| `resolveCodexCredential(opts)` | `async function` | 单文件解析（必要时刷新），签名与旧版一致 |
| `apply(ctx, config)` | `function` | 插件入口，装配池、打桩 `credentials`、注册路由，返回 dispose |
| `DEFAULT_STRATEGY` | `string` | 从 `lib/rotation.js` 重新导出 |

**内部结构（分区）**

- **配置区**：`configValue()`（兼容 plain/reactive 配置）、`readSettings()`（读
  `accountsDir` / `quotaProbe` / `proxyUrl` / `rotateOnQuotaExhausted` / `strategy`，`rotateOnQuotaExhausted === false`
  时把策略降级为 `"sticky"`）。
- **常量区**：`CLIENT_ID`、`REFRESH_URL`、`REFRESH_WINDOW_MS`、`PROBE_MAX_AGE_MS`（10 分钟，
  无租期读数的兜底新鲜度）、`PROBE_MIN_WAIT_MS`（60 秒，调度的下限）、模块级 `leaseTimer`
  （池共用、`unref`）与 `refreshInflight`（按文件路径去重）。
- **传输与令牌**：`requesterFor()`、`refresh()`、`tokenFor()`、`bearerFrom()`、`resolveCodexCredential()`。
- **池服务**：`createService({ settings, pool })` → `{ resolve, observe, wrapFetch, snapshot, integration, noteAdapterRequest, warm, scheduleLease, pin, … }`（内部还有 `probeAll()` 与 `probedProxy`，见 [03](./03-api-reference.md#createService-settings-pool)）。
- **装配**：`anyConfigured()`、`apply()`（创建服务后立刻 `void service.warm()` 后台预热池，随后 `service.scheduleLease()` 起池级定时器）、`registerQuotaRoute()`。

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
  `DEFAULT_COOLDOWN_MS = 15min`、`TRANSPORT_COOLDOWN_MS = 30s`、`PROBE_BACKOFF_BASE_MS = 60s`、
  `PROBE_RETRY_LIMIT = 3`、`normalizeStrategy()`。
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
- `leaseOf(quota, fallbackMs)` / `earliestQuotaDueAt()`：读数的租期 —— 有服务端 `renewalSeconds`
  就用它，否则用兜底的最大新鲜度；池内每个账号的到期时间取 `max(读数到期, 自己的重试时间)`，
  `earliestQuotaDueAt()` 给出其中最早者（空池返回 `undefined`）。
- `markProbeFailure()` / `resetProbeAttempts()`：**次数消耗式**重试 —— 一次触发 = 首次 + 最多 3 次
  重试（退避 60/120/240 秒）；用尽后 `probeHalted`（`quotaStale` 对它返回 `false`，调度也不再排它），
  只有 `resetProbeAttempts()`（打开面板强制刷新时调用）把次数全部还回。任何一次成功读数
  （`recordQuota`）或被动响应（`recordOutcome`）都会清掉这些计数。
- `poolSnapshot(pool, now)`：给 `/api/codex-pool` 用的可序列化视图。

---

## lib/probe.js — 主动额度读取

**职责**：主动读一次某账号的额度，**订阅优先、拉取兜底**。

- `USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"`（拉取，GET）；
  `SUBSCRIPTIONS_URL = "…/wham/usage/subscriptions"`（订阅，POST，无 body）。
- `parseUsage(payload, now)`：递归收集含 `used_percent` 的对象，**按声明长度 `limit_window_seconds`
  分槽**（≤18000 → 5 小时窗口，>18000 → 本周窗口）。`primary_window`/`secondary_window` 是位置
  命名而非描述性命名：只发一个窗口的档位会把周窗口放进 `primary_window`，所以只能按长度判。
  输出与 `parseQuota` 同形状（`source: "probe"`）；某槽位缺失即留空，不借另一个窗口的数字；
  两个窗口都没声明长度时才回落到「短的在前」。
- `probeQuota({ token, accountId, fetchImpl, refresh, url, now })`：`GET`，
  头为 `accept` / `authorization` / `chatgpt-account-id`，15 秒超时；
  401 且提供了 `refresh` 时刷新一次再重试；任何失败/非 2xx/解析异常一律返回 `undefined`
  （探测是增强，不是依赖）。**刻意不带 `renewalSeconds`**。
- `probeSubscriptions({ … })`：`POST` 同批参数，头另加 `OAI-App-Brand: codex` 与
  `x-openai-codex-pricing-chooser: 1`；响应里的 `renewal_seconds`（>0 才采纳）挂到读数的
  `renewalSeconds` 上，即「服务端指定下次多久再来」。
- `readQuota(options)`：先 `probeSubscriptions()`，拿到读数即返回；否则回落 `probeQuota()`。

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
- **打开面板即刷新**：挂载时同时 `GET /api/codex-pool` 与 `POST {refresh:true}`（强制宿主重读
  全部账号），随后每 **15 秒** `GET` 一次（与设置页同源，无需额外鉴权面）；
- 展示的是**「剩余 N%」而非「已用」**：`remainingPercent(usedPercent) = 100 - usedPercent`，
  `toneFor` 分档 ≤0 耗尽 / ≤20 告警 / 其余正常 / 未知 idle，`Meter` 据此渲染进度条与重置倒计时；
- 网络失败时保留最后一次读数，并把角标降级为「已断开」；从未成功过则提示
  「多账号额度不可用（当前运行环境未提供 Web 接口）」；
- 账号列表为空时先看 `snapshot.integration`：`hooked === false && stockAdapter === true`
  说明补丁未生效，显示告警「额度观测未生效：当前 llm-pi-ai 未适配本插件……」；
  否则提示「尚未列出账号：账号目录仍在读取，或未发现任何登录……」。池在插件装配时就已后台预热
  （见 [`warm()`](./03-api-reference.md#warm)），因此正常情况下列表随设置页打开即出现，
  这条提示只在预热尚未完成或 `accountsDir` 下确无登录时短暂可见；
- 每个账号渲染 5 小时 / 本周两条进度条（`--dsw-alias-bg-layer-2` 作轨道，
  `--dsw-alias-state-success/warn/error-primary` 对应剩余 >20% / ≤20% / ≤0），
  行首为账号 id 与「当前」标记（取 `lastUsedAt` 最大者），行内 meta 为
  「上次使用 N 分钟前 / 尚未使用」及健康状况，尾部是可用性角标与重置倒计时。
- **手动固定**：行尾按钮「用此账号」/「取消固定」`POST` 同一路由
  `{ pin: "<id>" | null }`，标题栏在已固定时出现「恢复自动」；`POST` 的响应体就是新的池快照，
  直接顶替当前读数，不必等下一个刷新周期。失败显示「切换账号失败，请重试」。
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
   —— `accountsDir` 留空即用默认 `$CODEX_HOME/accounts`。`quotaProbe: true` 时，插件会在**启动
   预热**时（以及首个 `resolve()` 拿到不同的 `proxyUrl` 时）主动读一次各账号额度，让面板无需
   等待首个模型请求；读取的节奏由服务端 `renewal_seconds` 驱动（下限 60 秒），失败按次数退避。
   provider 走代理时，这里也要填同样的 `proxyUrl`（`# proxyUrl: "http://127.0.0.1:7890"`），
   否则只能直连、在需要代理的网络里必然失败。

---

## patches/ — 官方包补丁

`patches/` 下现有两个文件：`@deepseek-ai__dsh-llm-pi-ai@0.2.1-rc.2.patch`（当前宿主
dsh 0.2.1-rc.2 使用，其自带 pi-ai 即 0.2.1-rc.2），以及 `@0.2.0-rc.2.patch`（保留给仍停在
dsh 0.2.0-rc.2 的宿主）。

**职责**：为官方 `@deepseek-ai/dsh-llm-pi-ai@0.2.1-rc.2` 增加**每 provider 独立代理**支持，
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

**版本绑定**：补丁由 pnpm 的 `patchedDependencies` 托管，key **精确等于**被补丁包版本
`@deepseek-ai/dsh-llm-pi-ai@0.2.1-rc.2`（旧 key 为 `@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2`）。
官方包升到新版本后 key 不再匹配，pnpm **既不报错也不
应用** —— 补丁静默失效。另外磁盘上存在多份 `dsh-llm-pi-ai`（CLI 安装树、`profiles/node_modules`
共享层、`profiles/web/node_modules` 私有层），运行时生效的是 web profile 私有层那份，补丁必须
落在它上面。升级适配与校验步骤见 [README · 官方包补丁与升级适配](../README.md#官方包补丁与升级适配)。

**失效自检**：面板不靠猜文件路径判断补丁是否生效 —— `wrapFetch` 被调用即置
`integration.hooked`，原版适配器解析凭据时不带 `options` 则置 `integration.stockAdapter`，
两者组合即可区分「还没请求过」与「补丁没生效」（见
[03-api-reference.md](./03-api-reference.md#integration)）。

---

## test/ — 单元测试

`npm test` 运行三个文件，共 **31** 个用例（`node:test` + `node:assert/strict`）。

**test/auth.test.js（4 例，认证桥）**

| 用例 | 验证点 |
| --- | --- |
| `returns a fresh Codex access token without network access` | token 未过期时，**不触发** `fetchImpl` |
| `refreshes an expiring token and preserves the Codex auth document` | 过期时刷新；校验请求体；写回后保留其它字段并更新 `last_refresh` |
| `only intercepts the dedicated credential reference` | 非目标引用透传；`dispose()` 还原 `resolve/describe` |
| `reports the live Codex login as a configured read-only credential` | `describe` 返回 `writable: false` |

**test/pool.test.js（22 例，账号池）**

| 用例 | 验证点 |
| --- | --- |
| 空 `accounts/` 目录回退 legacy | 单账号兼容路径 |
| 子目录成池并排序 | `discoverAccounts` 的排序与 id |
| quota 响应头归一到两个窗口 | `parseQuota` |
| `readQuota` 优先订阅端点并保留租期 | 只 `POST SUBSCRIPTIONS_URL`；带 `renewalSeconds` 与订阅头 |
| `readQuota` 回落拉取，且拉取不带租期 | 先订阅、失败才 `GET USAGE_URL`；`renewalSeconds === undefined` |
| 服务端租期让读数超过调用方的新鲜度界仍新鲜 | `leaseOf` / `quotaStale` |
| `earliestQuotaDueAt` 指出池内最早到期读数 | 空池 `undefined`；未读过的账号即刻到期 |
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
| 打开面板重读池且不动固定 | `POST {refresh:true}` 强制重读，`pinned` 保持不变 |
| 探测失败把等待翻倍而非每分钟重试 | 退避 60 / 120 / 240 秒 |
| 次数用尽后账号停探 | `probeHalted`：最早到期 `undefined` 且 `quotaStale` 为 `false` |
| 打开面板把次数还回 | `resetProbeAttempts` 后重新到期 |
| 一次读数或被动响应清掉已耗次数 | `recordQuota` / `recordOutcome` |

**test/probe.test.js（5 例，额度读取：窗口分槽）**

| 用例 | 验证点 |
| --- | --- |
| 周窗口被发成 `primary_window` 时仍进周槽位 | 按声明长度分槽，不信任位置命名 |
| 两个窗口各归其位，与 payload 顺序无关 | 18000 秒 → 5 小时槽，604800 秒 → 周槽 |
| 单独的 5 小时窗口让周槽位留空 | 缺失槽位留 `undefined`，不借另一个窗口的数字 |
| 两个窗口都没声明长度仍按短的在前 | 旧「短的在前」兜底 |
| 无窗口的 payload 读作无读数 | `parseUsage` 返回 `undefined` |

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