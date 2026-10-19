# 01 · 整体架构

## 1. 背景与目标

DeepSeek Harness（以下简称 DSH）通过官方 `llm-pi-ai` 适配器接入各模型 provider。每个 provider
路由通过 `apiKeyEnv` 字段声明**凭据引用名**，运行时由 DSH 的 `credentials` 服务解析出实际密钥。

Codex CLI 已经在 `$CODEX_HOME/auth.json` 中保存了 ChatGPT 的 OAuth 令牌。本插件的目标：

> 让 `llm-pi-ai` 的 `openai-codex` 路由把 `OPENAI_CODEX_AUTH` 这一引用解析为 Codex CLI 的
> **实时 access token**，token 始终留在 Codex 自己的文件里，不复制、不落库；
> 有多个登录时按额度自动挑选与轮换。

## 2. 组件拓扑

```text
┌────────────────────────────────────────────────────────────────────────┐
│                          DeepSeek Harness 宿主                          │
│                                                                         │
│  ┌────────────────┐  resolve("OPENAI_CODEX_AUTH",{proxyUrl})  ┌───────┐ │
│  │  llm-pi-ai     │ ─────────────────────────────────────────▶│creden-│ │
│  │ (官方适配器)    │                                           │ tials │ │
│  └───────┬────────┘                                           └───┬───┘ │
│          │ 路由 openai-codex                      被本插件打桩覆盖 │     │
│          │ apiKeyEnv=OPENAI_CODEX_AUTH                            ▼     │
│          │  fetch = rotation.wrapFetch(proxyFetch)        ┌───────────┐ │
│          │◀──────────────────────────────────────────────│codex-cli- │ │
│  ┌───────┴────────┐   insert (cordis.patch.yml)           │  auth     │ │
│  │ Cordis 插件系统 │──────────────────────────────────────▶│ (index.js)│ │
│  └────────────────┘                                       └─────┬─────┘ │
│                                                                 │       │
│                          ┌──────────────┐  GET /api/codex-pool  │       │
│  ┌────────────────────┐  │  webServer   │◀──── client.js ───────┤       │
│  │ Web UI 设置页       │  │ (宿主路由表)  │   QuotaPanel GET/POST  │       │
│  │ (provider-card)    │──│              │                       │       │
│  └────────────────────┘  └──────────────┘                       ▼       │
└──────────────────────────────────────────────────────── $CODEX_HOME/ ────┘
                                                          ├ auth.json
                                                          └ accounts/
                                                            ├ work/auth.json
                                                            └ personal/auth.json
```

四个协作面：

| 面 | 载体 | 作用 |
| --- | --- | --- |
| **认证桥**（服务端） | [index.js](../index.js) | 覆盖 `credentials.resolve/describe`，按账号池解析并刷新 Codex token，观测额度 |
| **账号池**（服务端） | [lib/](../lib) | 账号发现、额度解析、健康分/冷却与选择策略 |
| **路由注入**（配置） | [cordis.patch.yml](../cordis.patch.yml) | 给 `llm-pi-ai` 挂 `openai-codex` 路由 + 插入本插件 + 池参数 |
| **设置 UI**（浏览器端） | [client.js](../client.js) | 在模型页 provider 卡片注入「网络代理」输入框与「多账号额度」面板（含手动固定账号） |
| **代理与观测**（补丁） | [patches/…pi-ai@0.2.1-rc.2.patch](../patches) | 给官方包增加 `proxyUrl` 支持与 `fetch` 注入点；**与官方包版本强绑定**，官方包升级后需重做（见 [README](../README.md#官方包补丁与升级适配)） |

## 3. 运行时数据流（一次模型请求）

1. `llm-pi-ai` 要发请求，调用 `credentials.resolve("OPENAI_CODEX_AUTH", { proxyUrl })`。
2. 本插件替换后的 `resolve` 判断引用名匹配 → 交给账号池 `service.resolve({ proxyUrl })`。
3. `discoverAccounts()` 列出池成员：
   - 有 `$CODEX_HOME/accounts/<name>/auth.json` 子目录 → 全部作为账号（按 id 排序）；
   - 否则回退为单账号 `$CODEX_HOME/auth.json`（id `default`）。
4. `prunePool()` 丢掉已从磁盘消失的账号状态（并清掉失效的 sticky / 固定账号），然后循环：
   - 只剩一个候选时直接取它，否则调 `selectAccount()`：**手动固定的账号优先**（前提是它可用），
     未被固定或固定账号不可用时才按 `strategy` 选择；
   - `tokenFor()` 读取该账号 `auth.json`：`expiresAt(access_token) > now + 5min` 直接返回，
     否则进入刷新分支（`refreshInflight` 按文件路径单飞去重）。
   - 成功 → `noteToken()` 记住 token↔账号、`markUsed()` 标记使用时间，返回 `{ value: token }`；
   - 失败（读不到 / 刷不动）→ `markCooldown(+30s)` 并试下一个账号。
5. 若开启了 `quotaProbe` 且该账号的额度读数已过它的租期（`renewalSeconds`，或没有租期时的
   `PROBE_MAX_AGE_MS`），**异步**读一次额度：先订阅 `POST …/wham/usage/subscriptions`（带
   `renewal_seconds`），失败才回落拉取 `GET …/wham/usage`；两者复用同一 `proxyUrl`（同进程
   `undici.ProxyAgent`），结果写回池状态；本次请求不等它。
6. `llm-pi-ai` 用拿到的 token 发模型请求，`fetch` 已被补丁包成
   `rotation.wrapFetch(proxyFetch(profile.proxyUrl))`：
   - `proxyFetch` 决定网络出口（代理或直连）——**与未安装本插件时完全一致**；
   - `wrapFetch` 在 `await` 之后读取响应状态码与额度响应头，`observe()` 归因到对应账号；
   - **响应对象原样返回**，不改 body、不缓冲 SSE。
7. 下一次请求的选择因此看到刚刚观测到的额度：某个账号窗口耗尽就被跳过，自动切换。

## 4. 插件生命周期

```text
DSH 启动
  └─ 应用 cordis.patch.yml
        ├─ 修改 llm-pi-ai 配置：新增 openai-codex provider（apiKeyEnv=OPENAI_CODEX_AUTH）
        └─ insert 插件 id=codex-cli-auth（模块 deepseek-harness-codex-auth）
              └─ index.js: apply(ctx, config)
                    ├─ readSettings(config)  读 accountsDir / strategy / quotaProbe / proxyUrl
                    ├─ createPool() + createService()
                    ├─ void service.warm()                      ← 后台预热账号池（quotaProbe 时顺带读取）
                    ├─ service.scheduleLease()                  ← 池共用一个 unref 定时器，按最早到期重读
                    ├─ ctx.get("credentials") 保存并替换 resolve / describe
                    ├─ ctx.provide("codexMultiAuth", service)   ← 供补丁后的适配器查找
                    ├─ ctx.inject(["webServer"], …)             ← 注册 /api/codex-pool（无则跳过）
                    └─ 返回 dispose：注销路由、撤销 provide、还原 resolve/describe

浏览器端（Web profile）
  └─ client.js: window.__ModuleLoader__.load({...})
        └─ apply(ctx)
              └─ 在 settings.models.provider-card 注入 CodexProviderCard
                    ├─ ProxyField（写 providers["openai-codex"].proxyUrl）
                    └─ QuotaPanel（打开即 POST {refresh:true} 强制重读，之后每 15 秒 GET 快照；
                                   按「剩余 N%」渲染额度；POST 同一路由固定 / 取消固定账号）
```

## 5. 关键设计约束

- **单一引用拦截**：只处理 `OPENAI_CODEX_AUTH`，其它引用一律透传给原始实现，
  保证与 DSH 其它凭据（环境变量、Harness 凭据库）互不干扰。
- **token 不落地**：access/refresh token 不复制进 Harness 配置或凭据文件，始终以
  `auth.json` 为唯一事实来源。
- **只读凭据语义**：`describe()` 对 `OPENAI_CODEX_AUTH` 返回 `writable: false`，
  告知 UI 该凭据不可由 Harness 编辑（只能通过 `codex login` 修改）。
- **代理语义不变**：网络出口完全由 `llm-pi-ai` 的 `proxyFetch(profile.proxyUrl)` 决定；
  额度观测层包在它**外面**，只读响应，不改请求。沿用同一 `proxyUrl` 做探测与刷新。
- **接线靠补丁，失效可自证**：观测层经补丁的 `fetchFor` → `profileFetch` → `wrapFetch` 接入，
  插件与官方包之间只有 `codexMultiAuth` 一个约定名。补丁缺失时 `wrapFetch` 不会被调用，
  插件据 `integration`（`hooked` / `stockAdapter`）在面板上报「补丁未生效」，而不是静默空白。
- **向后兼容**：没有 `accounts/` 目录时退化为单账号；`resolveCodexCredential()` 的签名与
  行为不变；`describe` 返回的字段集合不变。
- **原子写回**：`writeAccountAuth()` 先写同目录临时文件再 `rename`，并设 `mode: 0o600`，
  避免半写状态与宽权限。
- **并发安全**：`refreshInflight` 按文件路径去重同进程刷新；写回前的 `refresh_token` 比对，
  处理跨进程（Codex CLI ↔ Harness）竞态。
- **切换粒度**：额度在**下一个请求**生效，不在请求内重放 429——避免把一次用户操作放大成多次调用。
  手动固定走的是同一条时间线：只影响之后的请求，不打断正在进行的流。
- **固定是兜底，不是硬钉**：`pool.pinned` 只在被固定账号可用时生效；它耗尽或冷却时临时回退到
  `strategy`，窗口重置后自动回到该账号（面板明示）。固定态仅存于进程内存，重启即回到自动。
- **观测失败隔离**：`observe()` / 探测全程 try-catch，归因失败绝不影响正常请求。
- **明确失败**：读不到文件、缺少 tokens、刷新 HTTP 失败或返回体不含 token 时抛出带
  可操作提示的错误（`run "codex login"`），不做静默降级。
- **文件型凭据限定**：当前仅支持文件型 `auth.json`；若 Codex 仅使用系统钥匙串，
  插件会明确报错而非猜测。

## 6. 边界与不支持项

- 不复用/导入 Codex 的历史对话，只复用登录凭据。
- 不支持非文件型存储（系统钥匙串）。
- 额度状态仅存于进程内存，重启后重新观测。
- **手动固定的账号同样不落盘**：重启后回到 `strategy` 自动选择，这是刻意的默认值。
- 手动固定只能选池中已有状态的账号（`POST /api/codex-pool` 会对未知 id 返回 404）；该路由与
  `GET` 一样是同源、无鉴权的本地面板接口。
- 代理（`proxyUrl`）与被动额度观测**同属一个补丁**：未打补丁时两者一起失效 —— `proxyUrl`
  字段无处存放，观测层也拿不到请求，面板显示「额度观测未生效」告警（主动探测 `quotaProbe`
  不依赖补丁，仍可用）。补丁由 pnpm `patchedDependencies` 托管且 key 精确到版本，官方包升级
  后需重做，步骤见 [README · 官方包补丁与升级适配](../README.md#官方包补丁与升级适配)。
- 额度面板依赖宿主的 `webServer` 服务；无头（headless）组合下 `ctx.inject(["webServer"], …)`
  不执行，面板显示「多账号额度不可用」。
- 本插件为**本机可信插件**：它与 Codex CLI 共享 refresh token，不应安装到不可信 profile。