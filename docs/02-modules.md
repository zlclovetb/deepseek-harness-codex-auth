# 02 · 模块职责

## 目录结构

```text
deepseek-harness-codex-auth/
├── index.js                 # 服务端插件：认证桥（核心）
├── client.js                # 浏览器端插件：设置页“网络代理”字段
├── cordis.patch.yml         # Bundle patch：注册 openai-codex 路由 + 插入本插件
├── patches/
│   └── @deepseek-ai__dsh-llm-pi-ai@0.2.0-rc.2.patch   # 给官方包增加 proxyUrl 能力
├── test/
│   └── auth.test.js         # node:test 单元测试
├── package.json             # 包元数据 + dsh bundle/client 声明
├── package-lock.json        # 依赖锁（undici）
├── README.md                # 面向使用者的说明
├── LICENSE                  # MIT
└── deepseek-harness-codex-auth-0.2.2.tgz   # 打包产物
```

---

## index.js — 服务端 / 认证桥

**职责**：作为 Cordis 插件接管 `credentials` 服务中对 `OPENAI_CODEX_AUTH` 的解析与描述。

**导出符号**

| 导出 | 类型 | 说明 |
| --- | --- | --- |
| `name` | `string` | Cordis 插件名 `"codex-cli-auth"` |
| `inject` | `string[]` | `["credentials"]`，声明依赖宿主凭据服务 |
| `CODEX_CREDENTIAL_REF` | `string` | 被拦截的引用名 `"OPENAI_CODEX_AUTH"` |
| `resolveCodexCredential(opts)` | `async function` | 解析（必要时刷新）Codex access token，可独立测试 |
| `apply(ctx)` | `function` | 插件入口，打桩 `credentials`，返回 dispose |

**内部结构（分区）**

- **常量区**：`CLIENT_ID`（Codex 公开 OAuth 客户端 id）、`REFRESH_URL`、`REFRESH_WINDOW_MS`
  （5 分钟提前刷新窗口）、模块级 `refreshInflight`（并发去重单例）。
- **路径与 IO**：`authPath()`、`readAuth()`、`writeAuth()`。
- **JWT 工具**：`expiresAt()`。
- **刷新逻辑**：`refresh()`。
- **对外解析**：`resolveCodexCredential()`。
- **插件装配**：`apply()`。

详见 [03-api-reference.md](./03-api-reference.md)。

---

## client.js — 浏览器端模块

**职责**：在 Web 设置页的「模型 → provider 卡片」区域，为 `openai-codex` 卡片注入一个
“网络代理”输入框，并把值写入配置 `providers["openai-codex"].proxyUrl`。

**形态**：不是普通 ESM 模块，而是通过宿主提供的 `window.__ModuleLoader__.load({ id, factory })`
注册的浏览器端模块。`factory(require)` 内用 `require("react")` / `require("react/jsx-runtime")`
（由宿主注入 React，而非 npm 解析）。

**导出**：`module.exports = { apply, inject }`，其中 `inject = ["slots", "configForms"]`。

**关键点**

- `ProxyField` 仅当 `provider.provider === "openai-codex"` 时渲染，其它 provider 返回 `null`。
- 通过 `React.useSyncExternalStore(form.subscribe, form.getSnapshot)` 订阅配置表单快照，
  读取当前 `proxyUrl` 并保持受控输入同步。
- 保存走 `form.mutate([{ op: "set" | "unset", path: ["providers", "openai-codex", "proxyUrl"] }])`：
  非空则 `set`，留空则 `unset`。
- 校验 `validProxyUrl()`：仅接受 `http:` / `https:` 协议，否则展示错误提示且禁用保存。
- 用宿主 CSS 变量（`--dsw-alias-*`、`--dsw-radius-md`）保持与 DSH 主题一致。
- `apply(ctx)` 用 `ctx.configForms.whileServed(["llm-pi-ai"], …)` 确保仅在 `llm-pi-ai`
  表单被服务时注册，并通过 `ctx.slots.inject("settings.models.provider-card", …)` 完成槽位注入。

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

2. **insert 本插件**：
   ```yaml
   - id: codex-cli-auth
     name: deepseek-harness-codex-auth
   ```
   —— 注册认证桥，顺序保证 provider 与桥同时生效。

---

## patches/@deepseek-ai__dsh-llm-pi-ai@0.2.0-rc.2.patch — 官方包补丁

**职责**：为官方 `@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2` 增加 **每 provider 独立代理**支持。

**改动点**（详见 [04-dependencies.md](./04-dependencies.md#补丁-patch-chan)）：

1. `lib/index.js`
   - 引入 `undici` 的 `ProxyAgent` / `fetch`；
   - `profile` schema 增加 `proxyUrl`；
   - 新增 `proxyFetch(proxyUrl)`：按 URL 缓存 `ProxyAgent` 并返回带 dispatcher 的 fetch；
   - `profileOptions()` 把 `profile.proxyUrl` 映射为 pi-ai 的 `fetch` 选项；
   - 凭据解析时把 `{ proxyUrl: profile.proxyUrl }` 透传给 `credentials.resolve`。
2. `lib/types/config.d.ts`：补充 `proxyUrl` 类型声明。
3. `package.json`：新增 `undici` 依赖。

**条件性**：这是可选增强。未打补丁时插件主体（token 桥）仍工作，只是没有
“网络代理”字段与其生效路径。

---

## test/auth.test.js — 单元测试

**职责**：用 Node 内置 `node:test` + `node:assert/strict` 覆盖认证桥的核心行为。

**用例**

| 用例 | 验证点 |
| --- | --- |
| `returns a fresh Codex access token without network access` | token 未过期时，**不触发** `fetchImpl`（传入了会 `assert.fail` 的 stub） |
| `refreshes an expiring token and preserves the Codex auth document` | 过期时发起刷新；校验请求体 `refresh_token`；写回后 `refresh_token` 更新、`account_id` 等字段保留、`last_refresh` 被写入 |
| `only intercepts the dedicated credential reference` | 非目标引用走原始实现；`dispose()` 能还原原始 `resolve/describe`；引用名常量正确 |
| `reports the live Codex login as a configured read-only credential` | 有登录文件时 `describe` 返回 `{ configured: true, source: "codex-cli", writable: false }` |

**辅助函数**：`jwt(exp)` 造最小 JWT，`fixture(exp)` 造临时 `auth.json`（`mkdtemp`）。

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
| `files` | 白名单 | 仅打包运行所需文件 |

**脚本**

- `npm test` → `node --test`
- `pack:check` → `npm pack --dry-run`