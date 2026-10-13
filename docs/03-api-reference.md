# 03 · 关键类与函数说明

本插件不含 class，全部以函数 + 模块级状态实现。以下按 [index.js](../index.js) 的书写顺序说明，
再说明 [client.js](../client.js) 的浏览器端符号。

---

## index.js

### 常量

#### `name = "codex-cli-auth"`
Cordis 插件名，需与 `cordis.patch.yml` 中 `insert[].id` 一致。

#### `inject = ["credentials"]`
插件依赖声明。Cordis 会先确保 `credentials` 服务就绪再调用 `apply`。

#### `CODEX_CREDENTIAL_REF = "OPENAI_CODEX_AUTH"`
唯一的拦截目标。必须与 `cordis.patch.yml` 中 `openai-codex.apiKeyEnv` 完全相同，否则
包装函数会把请求透传给原始实现，导致拿不到 Codex 凭据。

#### `CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"`
Codex CLI 使用的公开 OAuth 客户端 id，刷新令牌时作为 `client_id` 提交。
可用环境变量 `CODEX_APP_SERVER_LOGIN_CLIENT_ID` 覆盖。

#### `REFRESH_URL = "https://auth.openai.com/oauth/token"`
令牌刷新端点。可用环境变量 `CODEX_REFRESH_TOKEN_URL_OVERRIDE` 覆盖（便于测试/私有部署）。

#### `REFRESH_WINDOW_MS = 5 * 60 * 1000`
提前刷新窗口。当 access token 剩余有效期 ≤ 5 分钟时即触发刷新。

#### `let refreshInflight`（模块级）
正在进行的刷新 Promise。用于**进程内并发去重**：同一次过期窗口内多个请求只会发起一次网络刷新。

---

### 函数

#### `authPath(env = process.env): string`
返回 `auth.json` 的绝对路径。

- 优先取 `env.CODEX_HOME`，否则用 `join(homedir(), ".codex")`；
- 最终路径为 `<codexHome>/auth.json`。

```js
authPath()            // 默认 ~/.codex/auth.json
authPath({ CODEX_HOME: "D:/codex" })   // D:/codex/auth.json
```

#### `async readAuth(path): Promise<object>`
读取并**校验** Codex 登录文件。

- 读文件 / `JSON.parse` 失败 → 抛 `Cannot read Codex CLI login at <path>; run "codex login" first`（带 `cause`）。
- 校验 `auth.tokens.access_token` 与 `auth.tokens.refresh_token` 均为字符串，
  否则抛 `... has no ChatGPT OAuth tokens; run "codex login"`。
- 返回完整 auth 文档（保留 `auth_mode`、`tokens.account_id` 等未知字段，刷新写回时不丢数据）。

#### `expiresAt(token): number`
解析 JWT 的过期时间（毫秒）。

- 取 `token.split(".")[1]`，以 `base64url` 解码，读取 payload 的 `exp`（秒）并乘 1000；
- 解析失败或 `exp` 非数字 → 返回 `0`（视为已过期，触发刷新，属于安全的保守策略）。

#### `async writeAuth(path, auth): Promise<void>`
**原子**写回 auth 文档。

1. `mkdir(dirname(path), { recursive: true })` 确保目录存在；
2. 写临时文件 `<path>.<uuid>.tmp`：`JSON.stringify(auth, null, 2) + "\n"`，权限 `0o600`；
3. `rename` 覆盖目标（同目录 rename 在主流文件系统上原子）；
4. `finally` 中 `rm(temporary, { force: true })` 清理残留。

#### `async refresh(path, auth, fetchImpl): Promise<string>`
执行一次 OAuth refresh，并在安全时写回。

- 记录 `usedRefreshToken = auth.tokens.refresh_token`；
- `POST` 到刷新端点，body 含 `client_id` / `grant_type: "refresh_token"` / `refresh_token`，
  `AbortSignal.timeout(30_000)`；
- **失败分支**（`!response.ok`）：重读磁盘，若 `refresh_token` 已被他人更新 → 直接返回 `latest.tokens.access_token`
  （说明并发方已解决）；否则抛 `Codex CLI token refresh failed (HTTP <status>); run "codex login" again`。
- **成功分支**：解析响应，若不含字符串 `access_token` → 抛错；否则重读磁盘，
  - 若 `refresh_token` 已变（他人先写了）→ 返回 `latest.tokens.access_token`；
  - 否则把新的 `access_token`（以及可选的 `refresh_token`）写回 `latest`，
    更新 `last_refresh = new Date().toISOString()`，`writeAuth` 落盘，返回新 access token。

> 这是典型的**乐观并发控制**：用「读-比-写」避免与 Codex CLI 自身的刷新互相覆盖。

#### `async resolveCodexCredential({ path = authPath(), now = Date.now(), fetchImpl, proxyUrl } = {}): Promise<string>`

对外的凭据解析入口（也是测试直接调用的函数）。

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `path` | `authPath()` | auth.json 路径 |
| `now` | `Date.now()` | 判定是否过期的“当前时间”（可注入，便于测试） |
| `fetchImpl` | `undefined` | 自定义 fetch（可注入，便于测试/代理） |
| `proxyUrl` | `undefined` | HTTP(S) 代理；仅在不提供 `fetchImpl` 时用于构造 `ProxyAgent` |

流程：

1. `readAuth(path)`；
2. 若 `expiresAt(access_token) > now + REFRESH_WINDOW_MS` → **直接返回**，无网络请求；
3. 否则：若 `refreshInflight` 不存在，则
   - 有 `proxyUrl` 且无 `fetchImpl` 时构造 `new ProxyAgent(proxyUrl)`，
     `requester = (input, init) => undiciFetch(input, { ...init, dispatcher })`；
   - 无代理时 `requester = fetchImpl ?? globalThis.fetch`；
   - `refreshInflight = refresh(...).finally(() => { dispatcher?.close(); refreshInflight = undefined })`；
4. 返回 `refreshInflight`（并发调用共享同一 Promise）。

#### `apply(ctx): () => void`
Cordis 插件入口。

1. `const credentials = ctx.get("credentials")`；
2. 保存 `credentials.resolve` / `credentials.describe` 的**原始引用**；
3. 定义包装函数：
   - `resolve(ref, options)`：`String(ref) !== CODEX_CREDENTIAL_REF` 时 `originalResolve.call(credentials, ref, options)`；
     否则返回 `{ value: await resolveCodexCredential({ proxyUrl: options?.proxyUrl }), source: "codex-cli" }`。
   - `describe(ref)`：非目标引用透传；目标引用尝试 `readAuth(authPath())`，
     成功返回 `{ configured: true, source: "codex-cli", writable: false }`，
     失败返回 `{ configured: false, writable: false }`（不抛错，供 UI 展示状态）。
4. 覆盖 `credentials.resolve` / `credentials.describe`；
5. **返回 dispose**：仅当当前方法仍是自己的包装函数时才还原为原始实现
   （避免误还原其它插件后装的包装）。

---

## client.js

### `inject = ["slots", "configForms"]`
浏览器端插件依赖：槽位系统与配置表单服务。

### `validProxyUrl(value): boolean`
- 空值视为合法（表示直连）；
- 否则 `new URL(value)` 必须能解析且协议属于 `http:` / `https:`。

### `ProxyField({ provider, form })`
React 组件（用 `jsx`/`jsxs` 手写，无 JSX 编译）。职责：为 `openai-codex` 渲染代理输入行。

关键实现：

- `if (provider.provider !== "openai-codex") return null` —— 只作用于目标卡片；
- `React.useSyncExternalStore(form.subscribe, form.getSnapshot)` —— 订阅表单快照；
  `saved = snapshot.value?.providers?.["openai-codex"]?.proxyUrl ?? ""`；
- 本地 `value` / `state('idle'|'saving'|'saved'|'failed')` 状态；
  `useEffect(() => setValue(saved), [saved])` 在外部快照变化时回填；
- `save(event)`：`preventDefault`；非法或保存中直接返回；否则
  `form.mutate([ normalized ? { op: "set", path, value } : { op: "unset", path } ])`，
  按返回值置 `saved` / `failed`；
- 禁用条件：`snapshot.status !== "ready" || !snapshot.writable || state === "saving"`；
- 提示文案：非法 → “请输入 HTTP 或 HTTPS 代理地址”；成功 → “代理已保存，重启 DSH 后生效”。

### `apply(ctx)`
1. `const form = ctx.configForms.get("llm-pi-ai")` —— 取得 `llm-pi-ai` 的配置表单句柄；
2. `ctx.effect(() => ctx.configForms.whileServed(["llm-pi-ai"], () => ctx.slots.inject("settings.models.provider-card", () => ctx.slots.register({ name, key: "llm-pi-ai", inject: () => ({ form }) }, ProxyField))))`
   —— 仅在 `llm-pi-ai` 表单可见时注册槽位；`inject` 把 `form` 透传给 `ProxyField`。

### `module.exports = { apply, inject }`
模块加载器约定的导出；`factory` 返回该对象。

---

## 环境变量汇总

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `CODEX_HOME` | Codex 配置目录 | `~/.codex` |
| `CODEX_REFRESH_TOKEN_URL_OVERRIDE` | 覆盖刷新端点 | `https://auth.openai.com/oauth/token` |
| `CODEX_APP_SERVER_LOGIN_CLIENT_ID` | 覆盖 OAuth client id | `app_EMoamEEZ73f0CkXaXp7hrann` |