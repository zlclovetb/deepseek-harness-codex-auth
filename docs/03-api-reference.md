# 03 · 关键类与函数说明

本插件不含 class，全部以函数 + 模块级状态实现。以下按 [index.js](../index.js) 的书写顺序说明，
再依次说明 [lib/](../lib) 的账号池模块与 [client.js](../client.js) 的浏览器端符号。

---

## index.js

### 常量与导出

#### `name = "codex-cli-auth"`
Cordis 插件名，需与 `cordis.patch.yml` 中 `insert[].id` 一致。

#### `inject = ["credentials"]`
插件依赖声明。Cordis 会先确保 `credentials` 服务就绪再调用 `apply`。

#### `CODEX_CREDENTIAL_REF = "OPENAI_CODEX_AUTH"`
唯一的拦截目标。必须与 `cordis.patch.yml` 中 `openai-codex.apiKeyEnv` 完全相同，否则
包装函数会把请求透传给原始实现，导致拿不到 Codex 凭据。

#### `ROTATION_SERVICE = "codexMultiAuth"`
`ctx.provide()` 注册的服务名。补丁后的 `llm-pi-ai` 用 `ctx.get("codexMultiAuth")` 找到本插件，
再调 `service.wrapFetch(base)` 包住自己的 fetch。未安装本插件时该查找返回 `undefined`，
适配器行为不变。

#### `QUOTA_ROUTE = "/api/codex-pool"`
客户端面板轮询的**精确**路径，注册在宿主的 `webServer` 上。

#### `CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"`
Codex CLI 使用的公开 OAuth 客户端 id，刷新令牌时作为 `client_id` 提交。
可用环境变量 `CODEX_APP_SERVER_LOGIN_CLIENT_ID` 覆盖。

#### `REFRESH_URL = "https://auth.openai.com/oauth/token"`
令牌刷新端点。可用环境变量 `CODEX_REFRESH_TOKEN_URL_OVERRIDE` 覆盖（便于测试/私有部署）。

#### `REFRESH_WINDOW_MS = 5 * 60 * 1000`
提前刷新窗口。当 access token 剩余有效期 ≤ 5 分钟时即触发刷新。

#### `PROBE_MAX_AGE_MS = 10 * 60 * 1000`
主动探测结果的可信时长。比这更新的读数不会触发第二次探测。

#### `const refreshInflight`（模块级 `Map`）
`auth.json 路径 → 正在进行的刷新 Promise`。用于**按账号**去重：同一账号的过期窗口内
多个并发请求只会发起一次网络刷新。

---

### 配置解析

#### `configValue(config, key): unknown`
`config[key]` 既可能是普通值，也可能是 Cordis 的响应式单元；后者带 `get()`，此处统一取值。

#### `readSettings(config): { accountsDir, quotaProbe, rotateOnQuotaExhausted, strategy }`
- `rotateOnQuotaExhausted` 默认 `true`，显式 `false` 时等价于 `"sticky"`；
- `quotaProbe` 默认 `false`，必须显式为 `true` 才开启主动探测；
- `strategy` 经 `normalizeStrategy()` 归一，非法值回落到 `"hybrid"`。

---

### 函数

#### `authPath(env = process.env): string`
旧版的单文件路径：`<codexHome>/auth.json`。`resolveCodexCredential()` 的默认 `path` 仍是它。

#### `requesterFor(fetchImpl, proxyUrl): { request, close }`
统一构造「发网络请求的那个函数」：

- 有注入的 `fetchImpl` → 直接用，`close` 为 `undefined`；
- 否则无 `proxyUrl` → `globalThis.fetch`；
- 否则 `new ProxyAgent(proxyUrl)`，`request = (input, init) => undiciFetch(input, { ...init, dispatcher })`，
  `close()` 负责关闭 dispatcher。

刷新与主动探测共用它，因此两者走**同一个网络出口**。

#### `async refresh(path, auth, fetchImpl): Promise<string>`
执行一次 OAuth refresh，并在安全时写回。

- 记录 `usedRefreshToken = auth.tokens.refresh_token`；
- `POST` 到刷新端点，body 含 `client_id` / `grant_type: "refresh_token"` / `refresh_token`，
  `AbortSignal.timeout(30_000)`；
- **失败分支**（`!response.ok`）：重读磁盘，若 `refresh_token` 已被他人更新 → 直接返回
  `latest.tokens.access_token`（说明并发方已解决）；否则抛
  `Codex CLI token refresh failed (HTTP <status>); run "codex login" again`。
- **成功分支**：解析响应，若不含字符串 `access_token` → 抛错；否则重读磁盘，
  - 若 `refresh_token` 已变（他人先写了）→ 返回 `latest.tokens.access_token`；
  - 否则把新的 `access_token`（以及可选的 `refresh_token`）写回 `latest`，
    更新 `last_refresh = new Date().toISOString()`，`writeAccountAuth` 落盘，返回新 access token。

> 这是典型的**乐观并发控制**：用「读-比-写」避免与 Codex CLI 自身的刷新互相覆盖。

#### `async tokenFor(path, { now, fetchImpl, proxyUrl }): Promise<{ token, auth }>`
一个 auth 文件的实时 access token。

1. `readAccountAuth(path)`；
2. `expiresAt(access_token) > now + REFRESH_WINDOW_MS` → 直接返回该 token（**零网络开销**）；
3. 否则查 `refreshInflight.get(path)`；缺失则用 `requesterFor()` 起一次 `refresh()`，
   并在 `finally` 中删除表项、`close()` dispatcher；
4. 返回同一个 Promise 的结果（并发调用共享）。

#### resolveCodexCredential

```js
async resolveCodexCredential({ path = authPath(), now = Date.now(), fetchImpl, proxyUrl } = {}) → Promise<string>
```

单文件解析入口，**签名与行为与引入账号池之前完全一致**，供直接调用与既有测试使用。
内部是 `tokenFor(path, …)` 后取 `token`。

#### `bearerFrom(init): string | undefined`
从 fetch `init` 的 `headers`（可能是 `Headers`、数组或普通对象）中取出 `Bearer` 后的 token。
用于把响应归因到账号。

---

### 账号池服务

#### `createService({ settings, pool })`

返回：

| 成员 | 说明 |
| --- | --- |
| `strategy` / `accountsDir` / `quotaProbe` | 只读回显配置 |
| `resolve({ proxyUrl, now })` | 选账号并返回 `{ token, accountId, identity, accounts }` |
| `observe({ token, authorization, status, headers, now })` | 把一次响应归因到账号 |
| `wrapFetch(baseFetch)` | 返回观测版 fetch，**不改响应**；被调用即置 `integration.hooked` |
| `snapshot(now)` | `poolSnapshot()` 的可序列化视图 |
| `integration()` | 补丁自检状态 `{ hooked, stockAdapter }`，随 `/api/codex-pool` 下发 |
| `noteAdapterRequest(withOptions)` | 记录凭据调用是否带 profile options（原版适配器的判据） |
| `pool` | 池状态本体（诊断用） |

**`resolve({ proxyUrl, now })`**

1. `discoverAccounts()` → `prunePool(pool, ids)`（丢掉已消失的账号）；
2. 循环，最多试遍所有账号：
   - 只剩一个候选时直接用它，否则 `selectAccount(pool, remaining, { now })`；
   - `claim()` 成功即返回；
   - 失败（读不到 / 刷不动）→ `markCooldown(pool, id, now + 30_000)` 后试下一个；
3. 全部失败 → 抛出最后一次错误，或
   `Codex CLI pool at <dir> has no usable login; run "codex login" for an account`。

**`claim(entry, { now, proxyUrl, poolSize })`**

`tokenFor()` → `noteToken()`（记 token↔账号）→ `markUsed()` →
若 `settings.quotaProbe && quotaStale(pool, id, PROBE_MAX_AGE_MS, now)` 则
`void probeAccount(...)`（**不 await**，本次请求不等探测）。

> 「先选账号、再刷新」正是「下一个请求才切换」的实现方式：本次响应头观测到的额度，
> 影响的是下一次选择。

**`probeAccount(entry, { token, auth, proxyUrl, now })`**

`requesterFor(undefined, proxyUrl)` → `probeQuota({ token, accountId: accountIdentity(auth),
fetchImpl: request, refresh: () => refresh(entry.path, auth, request), now })` → `recordQuota()`；
`finally` 中 `close()`。整体 try-catch，探测失败不冒泡。

**`observe({ token, authorization, status, headers, now })`**

`token ?? bearerFrom({ headers: { authorization } })` → `accountForToken()` → `recordOutcome()`。
全程 try-catch：归因失败绝不影响正常请求。

**`wrapFetch(baseFetch)`**

```js
function wrapFetch(baseFetch) {
  const inner = baseFetch ?? globalThis.fetch;
  return async (input, init) => {
    integration.hooked = true;   // 补丁调过这里 → 整条链路是通的
    const token = bearerFrom(init);
    const response = await inner(input, init);
    observe({ token, status: response.status, headers: response.headers });
    return response;
  };
}
```

`baseFetch` 由调用方给出，因此**网络出口的决定权完全在调用方**（即 `llm-pi-ai` 的
`proxyFetch(profile.proxyUrl)`）；本层只读响应。`baseFetch` 为 `undefined` 时退化为
`globalThis.fetch`，与原行为一致。

> `integration.hooked` 只在 `wrapFetch` 内部置位，因此它是「补丁已生效」的**直接证据**：
> 补丁里的 `profileFetch` 每发一次请求都会调用本方法，反过来说，只要它被调用过，
> 就证明补丁找到并接上了本插件。与之互补的 `stockAdapter` 见
> [`noteAdapterRequest(withOptions)`](#noteadapterrequestwithoptions)。

#### `noteAdapterRequest(withOptions)`
补丁自检的另一半。原版适配器解析凭据时调 `credentials.resolve(ref)`（**无第二参**），
补丁版恒传 `{ proxyUrl: profile.proxyUrl }` —— 这个差异是「装的是原版还是补丁版」最早、
最便宜的判据。`withOptions` 为假时置 `integration.stockAdapter = true`。

它由 `apply()` 里的 `resolve(ref, options)` 包装调用，因此**不依赖任何文件路径猜测**。

#### `integration()`
返回 `{ hooked, stockAdapter }` 快照，随 `/api/codex-pool` 一并下发，供面板判读：

| `hooked` | `stockAdapter` | 含义 |
| --- | --- | --- |
| `true` | — | 补丁生效 |
| `false` | `true` | 补丁未生效（未应用，或官方包升级后失效）→ 面板告警 |
| `false` | `false` | 尚未发出请求，属于正常等待 |

#### `async anyConfigured(accountsDir, env): Promise<boolean>`
遍历发现到的账号，只要有一个能正常读取即返回 `true`，供 `describe()` 使用。

---

### 插件装配

#### apply(ctx, config)

返回 dispose 函数。步骤：

1. `readSettings(config)` → `createPool()` → `createService()`；
2. `const credentials = ctx.get("credentials")`，保存原始 `resolve` / `describe`；
3. 定义包装函数：
   - `resolve(ref, options)`：非目标引用 `originalResolve.call(credentials, ref, options)`；
     目标引用先调 `service.noteAdapterRequest(options !== undefined)`（补丁自检），
     再返回 `{ value: hit.token, source: "codex-cli" }`（`hit` 来自 `service.resolve`）。
   - `describe(ref)`：非目标引用透传；目标引用返回 `{ configured, source: "codex-cli", writable: false }`
     或 `{ configured: false, writable: false }`；**字段集合与旧版完全一致**（宿主会裁剪额外字段）；
4. 覆盖两个方法；
5. `ctx.provide(ROTATION_SERVICE, service)`；
6. `ctx.inject(["webServer"], (web) => registerQuotaRoute(web.webServer, service))`
   —— **可选作用域注入**：无 `webServer` 的（无头）组合只是不注册路由，插件照常加载；
7. **返回 dispose**：注销路由、撤销 provide、并且只在自己仍是当前实现时还原 `resolve/describe`
   （避免误还原其它插件后装的包装）。

#### `registerQuotaRoute(webServer, service): () => void`

`webServer.register({ kind: "exact", path: QUOTA_ROUTE, handler })`：

- `GET` → `200` + `service.snapshot()` 并附 `integration` 字段（补丁自检状态）的 JSON；
- 其它方法 → `405` + `{ error: "method not allowed" }`；
- 统一带 `cache-control: no-store`。**响应体里没有任何 token 或账号凭据**。

---

## lib/ 账号池

### accounts.js

| 导出 | 说明 |
| --- | --- |
| `codexHome(env)` | `env.CODEX_HOME`，否则 `~/.codex` |
| `legacyAuthPath(env)` | `<codexHome>/auth.json` |
| `resolveAccountsDir({ accountsDir, env })` | 显式配置 → `CODEX_ACCOUNTS_DIR` → `<codexHome>/accounts` |
| `decodeAccessToken(token)` | base64url 解 JWT payload，失败返回 `undefined` |
| `expiresAt(token)` | payload `exp` × 1000；读不到返回 `0`（保守视为过期） |
| `accountIdentity(auth)` | `https://api.openai.com/auth` 的 `chatgpt_account_id` → `tokens.account_id` → `payload.sub` |
| `readAccountAuth(path)` | 校验式读取（必须含 `tokens.access_token` 与 `tokens.refresh_token`） |
| `writeAccountAuth(path, auth)` | 临时文件 + `rename` 原子写，`mode 0o600` |
| `discoverAccounts({ accountsDir, env })` | `{ dir, pooled, accounts }`；无子目录时回退 `{ id: "default", path: legacyAuthPath() }` |
| `accountLabel(entry, auth)` | `name (identity 前 8 位…)` |

`discoverAccounts` 只做一次 `readdir`，不读取文件内容——发现必须是廉价的。

### quota.js

| 导出 | 说明 |
| --- | --- |
| `PRIMARY_WINDOW` / `SECONDARY_WINDOW` | `"primary"`（5 小时）/ `"secondary"`（本周） |
| `readHeader(headers, name)` | 兼容 `Headers` 与普通对象 |
| `parseQuota(headers, now)` | → `{ observedAt, primaryUsedPercent, primaryResetsAt, primaryWindowMinutes, secondary… }`；缺省字段保持 `undefined` |
| `hasQuota(quota)` | 是否至少有一个可用数字 |
| `mergeQuota(previous, next)` | 用新读数覆盖，`undefined` 不覆盖旧值 |
| `expireWindows(quota, now)` | 重置时刻已过的窗口清零并清掉 reset 时间 |
| `peakUsedPercent(quota)` | 两个窗口中的最高使用率 |
| `isQuotaExhausted(quota)` | `peak >= 100` |
| `quotaRetryAt(quota)` | 已满窗口中最晚的重置时刻 |

响应头名：`x-codex-primary-used-percent`、`x-codex-primary-reset-at`、
`x-codex-primary-reset-after-seconds`、`x-codex-primary-window-minutes`，secondary 同理。
`reset-at` 接受 epoch 秒 / epoch 毫秒 / ISO 字符串，缺失时回退 `reset-after-seconds`。

### rotation.js

| 导出 | 说明 |
| --- | --- |
| `STRATEGIES` / `DEFAULT_STRATEGY` | `["hybrid","round-robin","sticky"]` / `"hybrid"` |
| `DEFAULT_COOLDOWN_MS` / `TRANSPORT_COOLDOWN_MS` | 15 分钟 / 30 秒 |
| `normalizeStrategy(value)` | 非法值回落 `"hybrid"` |
| `createPool({ strategy, accountsDir })` | 池：`accounts` Map、`tokens` Map、`cursor`、`sticky` |
| `prunePool(pool, ids)` | 丢弃不在 `ids` 中的账号状态（并清掉失效的 sticky） |
| `noteToken` / `accountForToken` | token ↔ 账号归因 |
| `isAvailable(state, now)` | 冷却已过且未耗尽 |
| `retryAt(state, now)` | 冷却与额度重置中较晚者 |
| `selectAccount(pool, entries, { now })` | 按策略选择，见下 |
| `markUsed` / `markCooldown` | 记录使用时间 / 置入冷却 |
| `quotaStale(pool, id, maxAgeMs, now)` | 读数缺失或过期 |
| `recordQuota(pool, id, quota, now)` | 合并主动探测结果，未耗尽则解除冷却 |
| `recordOutcome(pool, id, { status, headers, now })` | 合并响应头并按状态码记账 |
| `poolSnapshot(pool, now)` | 见下 |

**`selectAccount` 的策略**

1. 用 `hybridOrder()` 排序：`剩余额度百分比 × 健康分` 降序，`lastUsedAt` 破平；
2. `round-robin`：在可用者中按 `cursor` 轮流；
3. `sticky`：优先保留当前 `pool.sticky`；
4. `hybrid`：取最佳可用者；
5. 全部不可用时：`round-robin` / `sticky` 退化为排序首位，`hybrid` 返回**最早恢复**者
   （便于上层报出真实重置时间，而不是「池为空」）。

> `selectAccount` **自身不做 `prunePool`**：它收到的是「尚未尝试」的子集，
> 若在此清理会误删未传入的账号状态。清理只在 `service.resolve()` 里显式做一次。

**`recordOutcome` 的记账规则**

| 状态码 | 处理 |
| --- | --- |
| `429` | `failures++`，冷落到额度窗口重置时间（无重置时间则 `now + 15min`）。**不扣健康分**——额度窗口已经表达了限流，再扣分会把账号在窗口重置后仍压在池底 |
| `>= 500` | `failures++`，`health = max(0.05, health × 0.7)`，冷却 30 秒 |
| `200–399` | `successes++`，`health = min(1, health + 0.2)`，未耗尽则清冷却 |

无论状态码如何，只要带了额度响应头就先 `mergeQuota` —— 429 往往正是携带额度的那一条。

**`poolSnapshot(pool, now)`** 返回

```json
{
  "strategy": "hybrid",
  "accountsDir": "C:\\Users\\me\\.codex\\accounts",
  "observedAt": 1760000000000,
  "accounts": [
    {
      "id": "work",
      "usedPercent5h": 12,
      "resetsAt5h": 1760003600000,
      "usedPercentWeekly": 48,
      "resetsAtWeekly": 1760500000000,
      "health": 1,
      "cooldownUntil": null,
      "lastUsedAt": 1760000000000,
      "available": true
    }
  ]
}
```

### probe.js

| 导出 | 说明 |
| --- | --- |
| `USAGE_URL` | `https://chatgpt.com/backend-api/wham/usage` |
| `parseUsage(payload, now)` | 递归收集含 `used_percent` 的对象，按 `windowSeconds` 升序分成 primary/secondary，输出与 `parseQuota` 同形状（带 `source: "probe"`） |
| `probeQuota({ token, accountId, fetchImpl, refresh, url, now })` | `GET`，头 `accept` / `authorization` / `chatgpt-account-id`，15 秒超时；401 且给了 `refresh` 时刷新一次再重试；任何失败返回 `undefined` |

---

## client.js

### `inject = ["slots", "configForms"]`
浏览器端插件依赖：槽位系统与配置表单服务。

### 常量
`QUOTA_ROUTE = "/api/codex-pool"`、`POLL_INTERVAL_MS = 15_000`、
`STRATEGY_LABEL`（策略中文名）、`STATE_COLOR`（状态色 → `--dsw-alias-state-*-primary`）。

### `validProxyUrl(value): boolean`
- 空值视为合法（表示直连）；
- 否则 `new URL(value)` 必须能解析且协议属于 `http:` / `https:`。

### `ProxyField({ provider, form })`
React 组件（用 `jsx`/`jsxs` 手写，无 JSX 编译）。职责：为 `openai-codex` 渲染代理输入行。

- `React.useSyncExternalStore(form.subscribe, form.getSnapshot)` 订阅表单快照；
  `saved = snapshot.value?.providers?.["openai-codex"]?.proxyUrl ?? ""`；
- 本地 `value` / `state('idle'|'saving'|'saved'|'failed')`；`useEffect` 在外部快照变化时回填；
- `save(event)`：`form.mutate([ normalized ? { op: "set", path, value } : { op: "unset", path } ])`；
- 禁用条件：`snapshot.status !== "ready" || !snapshot.writable || state === "saving"`。

### `usePool()`
轮询 hook。挂载时立即 `fetch(QUOTA_ROUTE)`，随后每 `POLL_INTERVAL_MS` 一次；
失败时保留上一次的 `snapshot`，只把 `status` 置为 `"offline"`；
卸载时 `clearInterval` 并置 `live = false` 丢弃迟到的响应。

### `QuotaPanel({ provider })`
- 同样只作用于 `openai-codex`；
- 标题显示策略名（`多账号额度 · 智能选择`）；
- 角标：`"读取中"` / `"已断开，显示最后一次读数"` / `"15 秒自动刷新"`；
- `currentId`：取 `lastUsedAt` 最大的账号，作为「当前」标记传给 `AccountRow`；
- 从未拿到快照 → 「多账号额度不可用（当前运行环境未提供 Web 接口）」；
- `unpatched`（`snapshot.integration.hooked === false && snapshot.integration.stockAdapter === true`）
  → 告警「额度观测未生效：当前 llm-pi-ai 未适配本插件……」，优先级高于「空列表」提示；
- `accounts` 为空 → 「尚未观测到账号：发起一次对话后，这里会显示各账号的额度」；
- 否则逐账号渲染 `AccountRow`。

### `sinceLabel(at, now)` / `resetLabel(at, now)`
把时间戳渲染成相对文案：前者「刚刚 / N 分钟前 / N 小时前 / N 天前」（用于「上次使用」），
后者「N 分钟后重置 / N 小时后重置 / N 天后重置」。

### `Meter({ label, usedPercent, resetAt, now })` / `AccountRow({ account, now, isCurrent })`
用量进度条与账号行：5 小时 / 本周两条，轨道用 `--dsw-alias-bg-layer-2`，
填充色按使用率取 `--dsw-alias-state-success-primary`（<80%）/
`--dsw-alias-state-warn-primary`（≥80%）/ `--dsw-alias-state-error-primary`（≥100%）；
未观测到读数时显示「暂无数据」。`AccountRow` 首行为账号 id 加条件渲染的「当前」标记，
次行为「上次使用 …／尚未使用」与健康状况（`health < 0.95` 时显示），尾部角标显示
可用 / 冷却中 / 额度耗尽。

### `CodexProviderCard(props)`
组合 `ProxyField` + `QuotaPanel`，统一做 `provider.provider === "openai-codex"` 判断。

### `apply(ctx)`
1. `const form = ctx.configForms.get("llm-pi-ai")`；
2. `ctx.effect(() => ctx.configForms.whileServed(["llm-pi-ai"], () => ctx.slots.inject("settings.models.provider-card", () => ctx.slots.register({ name, key: "llm-pi-ai", inject: () => ({ form }) }, CodexProviderCard))))`
   —— 仅在 `llm-pi-ai` 表单被服务时注册槽位。

### `module.exports = { apply, inject }`
模块加载器约定的导出；`factory` 返回该对象。

---

## 配置项汇总

`cordis.patch.yml` 的 `insert[].config`：

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `accountsDir` | `string` | `$CODEX_HOME/accounts` | 账号目录 |
| `strategy` | `"hybrid" \| "round-robin" \| "sticky"` | `"hybrid"` | 选择策略，非法值回落 `hybrid` |
| `quotaProbe` | `boolean` | `false` | 是否在请求前主动探测额度 |
| `rotateOnQuotaExhausted` | `boolean` | `true` | `false` 等价于 `strategy: "sticky"` |

## 环境变量汇总

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `CODEX_HOME` | Codex 配置目录 | `~/.codex` |
| `CODEX_ACCOUNTS_DIR` | 账号目录（低于显式配置、高于默认） | `<CODEX_HOME>/accounts` |
| `CODEX_REFRESH_TOKEN_URL_OVERRIDE` | 覆盖刷新端点 | `https://auth.openai.com/oauth/token` |
| `CODEX_APP_SERVER_LOGIN_CLIENT_ID` | 覆盖 OAuth client id | `app_EMoamEEZ73f0CkXaXp7hrann` |