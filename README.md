# deepseek-harness-codex-auth

让 DeepSeek Harness 的官方 `llm-pi-ai` 适配器直接复用 Codex CLI 的 ChatGPT 登录，并支持
**多个 Codex 账号自动轮换**。

插件只拦截 `OPENAI_CODEX_AUTH` 这一条凭据引用：设置页显示 Codex CLI 的只读登录状态，每次模型
请求按当前额度挑一个账号，读取它的 `auth.json`，access token 即将过期时按 Codex CLI 的协议刷新
并写回同一文件。token 不会复制到 Harness 配置或凭据文件。

## 账号布局

```text
$CODEX_HOME/                     # 默认 ~/.codex
├── auth.json                    # 单账号（旧布局，继续支持）
└── accounts/                    # 多账号布局
    ├── work/auth.json
    └── personal/auth.json
```

- 存在 `$CODEX_HOME/accounts/<name>/auth.json` 子目录时，插件把它们当作账号池；
- 没有该目录时回退到单一 `$CODEX_HOME/auth.json`（账号 id `default`），行为与旧版一致；
- 当前目录可用插件配置 `accountsDir` 或环境变量 `CODEX_ACCOUNTS_DIR` 覆盖；
- 每个子目录由 `codex login` 生成即可，例如 `CODEX_HOME=~/.codex/accounts/work codex login`。

## 轮换与额度

额度来自两个渠道，都会写进进程内的账号状态：

- **被动**（常态数据源）：每个模型响应的 `x-codex-primary-used-percent`（5 小时窗口）与
  `x-codex-secondary-used-percent`（本周窗口）等响应头，由 `wrapFetch` 始终观测；
- **主动**（可选，`quotaProbe: true`）：优先订阅 `POST …/wham/usage/subscriptions`，失败才回落
  拉取 `GET …/wham/usage`；订阅响应里的 `renewal_seconds` 即服务端指定的「下次多久再来」。

主动读取的**节奏由服务端说了算**：整个账号池共用一个 `unref` 定时器，按最早的到期读数安排下一次
读取（下限 60 秒，避免服务端给的节奏过短变成热循环），读数没有租期时才回落到固定的 10 分钟新鲜度。

而且这是**消耗次数、不是周期重试**：一次触发 = 首次尝试 + 最多 3 次重试（退避 60/120/240 秒）；
用尽后该账号停探、所有自动读取也停下，直到你打开模型页 —— 面板打开的 `{refresh:true}` 会强制重读
全部账号，才开启新一轮。

调度策略由 `strategy` 决定：

| 值 | 行为 |
| --- | --- |
| `hybrid`（默认） | 在可用账号中选「剩余额度 × 健康分」最高者 |
| `round-robin` | 在可用账号间轮流 |
| `sticky` | 固定一个账号，直到它的窗口耗尽 |

某个账号额度耗尽（任一窗口达到 100%）或返回 429 时，它会被冷落到该窗口的重置时间；后续请求自动
切到别的账号。**切换发生在下一个请求**，不会在一次请求内重放。

插件启动时会在后台**预热账号池**（只列出账号，与 `quotaProbe` 无关）：设置页的「多账号额度」面板
因此一重启就能列出所有账号，不必先发一次对话。账号的**额度数值**是否当场可读取决于 `quotaProbe`：
默认只有发过请求才有（被动）；设为 `true` 后启动时主动读一次；而**打开面板**随时会强制重读全部
账号。provider 走代理时，主动读取也需要代理：在插件配置里把 `proxyUrl` 填成与 provider 相同的地址，
否则只能直连、在需要代理的网络里必然失败。

要指定用哪个账号，在「多账号额度」面板点账号行右侧的「用此账号」手动固定，点顶部「恢复自动」
交还给上面的策略。固定是**兜底式**的：被固定的账号额度耗尽或冷却中时，会临时回退到策略选择
（面板会写明「已临时回退」），它的窗口一重置就自动回到该账号。固定状态只存在于进程内，
重启 DSH 后回到自动选择。

## 配置

`cordis.patch.yml` 的 `insert` 条目带以下配置（均为可选，括号内为默认值）：

| 键 | 说明 |
| --- | --- |
| `accountsDir` | 账号目录（默认 `$CODEX_HOME/accounts`） |
| `strategy` | `hybrid` / `round-robin` / `sticky`（默认 `hybrid`） |
| `quotaProbe` | 是否主动读取额度（订阅优先 + 拉取兜底）；关闭时只剩被动响应头（默认 `false`） |
| `proxyUrl` | 主动读取所用的代理，填与 provider 相同的地址（默认直连） |
| `rotateOnQuotaExhausted` | 设为 `false` 等价于 `strategy: sticky`（默认 `true`） |

## 安装

要求 Node.js `>=22.19.0`、DeepSeek Harness `0.2.0-rc.2`（宿主最低版本），以及已完成：

```powershell
codex login
codex login status
```

> 上面的 `0.2.0-rc.2` 是插件要求的**最低宿主版本**；补丁的 `patchedDependencies` key 与补丁文件名
> 必须**精确等于宿主实际安装的 `dsh-llm-pi-ai` 版本**，二者不是一回事（见下文「官方包补丁与升级适配」）。

在本仓库打包并安装到 Web profile：

```powershell
npm test
npm pack
dsh plugin --profile web add .\deepseek-harness-codex-auth-0.4.7.tgz
dsh --profile web --dump-config
dsh web
```

Bundle patch 会保留官方 `llm-pi-ai`，只加入 `openai-codex` 路由和认证桥。重启后在
模型选择器中选择 `openai-codex` 下的模型。

Web profile 同时应用 `patches/@deepseek-ai__dsh-llm-pi-ai@0.2.1-rc.2.patch` 后，模型页的
`openai-codex` 卡片会出现「网络代理」输入框和「多账号额度」面板。代理只用于此 provider；
建议同时把 `transport` 设为 `sse`，避免不支持 WebSocket 的 HTTP 代理先等待握手超时。
额度面板打开时即 `POST /api/codex-pool {refresh:true}` 强制重读全部账号，随后每 15 秒 `GET` 一次
同源快照；面板按**「剩余 N%」**展示各账号的 5 小时 / 本周窗口与重置倒计时，并可在面板内点
「用此账号」手动固定账号（`POST` 同一条路由）。读数超过 1 小时没更新时改显「读数过期 · N 小时前」；
窗口已重置但还没重新观测到时显示「暂无数据」，不会把旧数字当成 100% 剩余。

卸载：

```powershell
dsh plugin --profile web remove deepseek-harness-codex-auth
```

## 官方包补丁与升级适配

额度显示依赖对官方 `@deepseek-ai/dsh-llm-pi-ai` 的一处补丁。**官方包一升级，补丁就会失效**，
面板会退回「暂无数据」。因此这里写清「改了哪些代码、为什么这么改」，供下次升级时照着重新适配。

### 为什么必须改官方包

`llm-pi-ai` 负责发模型请求，插件只能从它留下的接口接入。原版有两个缺口：

| 需要的能力 | 原版现状 | 后果 |
| --- | --- | --- |
| 拿到本次请求用的 transport | `profileOptions()` 不向 pi-ai 传 `fetch`，pi-ai 只能回落到 `globalThis.fetch` | 观测层无处可挂，额度永远是空的 |
| 每 provider 独立代理 | provider profile 里没有 `proxyUrl` 字段 | 代理配置无处可放 |

### 改动清单

补丁文件：`patches/` 下现有两个，各对应一个宿主版本：

| 补丁文件 | 对应宿主 |
| --- | --- |
| [@deepseek-ai__dsh-llm-pi-ai@0.2.1-rc.2.patch](patches) | 当前：dsh 0.2.1-rc.2（其自带 pi-ai 即 0.2.1-rc.2），**必用** |
| [@deepseek-ai__dsh-llm-pi-ai@0.2.0-rc.2.patch](patches) | 仍停在 dsh 0.2.0-rc.2 的宿主 |

| # | 位置 | 改动 | 为什么 |
| --- | --- | --- | --- |
| 1 | 顶部 import | 引入 `undici` 的 `ProxyAgent` / `fetch` | 代理出口 |
| 2 | provider profile schema | 增加 `proxyUrl: z.string()` | 让 profile 能带代理 |
| 3 | 新增 `proxyFetch(proxyUrl)` | 按 URL 缓存 `ProxyAgent`，返回带 `dispatcher` 的 fetch | **原样保留既有代理逻辑**：网络出口只由这里决定 |
| 4 | 新增 `profileFetch(ctx, profile)` | `base = proxyUrl ? proxyFetch(proxyUrl) : undefined`；再 `ctx.get("codexMultiAuth")?.wrapFetch(base)` | 把观测层**包在代理外层**：请求怎么出去完全不变，只是顺路读一眼响应 |
| 5 | `profileOptions(...)` | 增加第 4 参 `fetchImpl`，透传 `{ fetch: fetchImpl }` | 把上面选好的 fetch 交给 pi-ai |
| 6 | 模型请求调用点 | `profileOptions(profile, reasoning, apiKey, this.config.fetchFor?.(profile))` | 接线 |
| 7 | `PiAiAdapter` 构造 | `fetchFor: (profile) => profileFetch(ctx, profile)` | 接线 |
| 8 | `resolveApiKey` | `credentials.resolve(ref, { proxyUrl: profile.proxyUrl })` | 令牌刷新、额度读取与模型请求走**同一个**出口 |
| 9 | `lib/types/config.d.ts` | 补 `proxyUrl` 类型声明 | 类型完整 |

第 4 项的三态是整套设计的关键 —— **补丁单独存在时不改变任何行为**：

```js
function profileFetch(ctx, profile) {
  const base = profile.proxyUrl === undefined ? undefined : proxyFetch(profile.proxyUrl);
  const rotation = ctx.get("codexMultiAuth");   // 本插件提供的观测层
  if (rotation === undefined) return base;      // 没装插件 → 与打补丁前一致
  return rotation.wrapFetch(base);              // 装了插件 → 只在其外层读响应
}
```

无代理且无插件时返回 `undefined`，`fetch` 选项**根本不注入**，与打补丁前逐字一致；观测层
永远在最外层，即使它彻底不工作，请求路径也不变。

### 补丁如何生效

不需要手动改 `node_modules`。补丁由 pnpm 通过 profile 的 `pnpm-workspace.yaml`
`patchedDependencies` 自动应用，`dsh plugin add` 也会重放它。

两点容易踩：

- **要落在 web profile 实际加载的那份**。磁盘上有多份 `dsh-llm-pi-ai`（CLI 安装树、
  `profiles/node_modules` 共享层、`profiles/web/node_modules` 私有层），运行时生效的是
  最后一份 —— 检查目标应是
  `…\.dsh\profiles\web\node_modules\@deepseek-ai\dsh-llm-pi-ai\lib\index.js`。
- 补丁**没有**修改官方包的 `package.json`，它 `import "undici"` 时依赖的是 web profile 里
  被提升上来的 `undici@8.11.2`（本插件的依赖）。升级后确认它仍能解析。

### 升级后如何重新适配

前提：只要 `profiles/web/package.json` 仍锁定 `@deepseek-ai/dsh-llm-pi-ai@0.2.1-rc.2`，
补丁就一直有效 —— 升级 DSH 应用本体不会自动改它。只有 profile 里的版本真的变了才需要走下面流程。
`patchedDependencies` 的旧 key 写作 `@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2`；它必须**精确等于**
被补丁包的版本，否则 pnpm 会静默跳过补丁（症状：额度一直空白、且没有任何报错）。升级要动三处：
profile `package.json` 的包版本 → `pnpm-workspace.yaml` 的 `patchedDependencies` key 与补丁文件名
一起改 → `pnpm install --no-frozen-lockfile`。

```powershell
# 1. 确认实际加载的版本与补丁状态（应至少各命中一次）
$f = "$env:USERPROFILE\.dsh\profiles\web\node_modules\@deepseek-ai\dsh-llm-pi-ai\lib\index.js"
Select-String -Path $f -Pattern "profileFetch","codexMultiAuth","fetchFor"

# 2. 把补丁文件重命名到新版本
#    patches/@deepseek-ai__dsh-llm-pi-ai@<新版本>.patch
#    并同步更新 profiles/web/pnpm-workspace.yaml 里 patchedDependencies 的 key

# 3. 逐条重做上表 9 处改动。原版里可直接搜索这些锚点：
#    ① import { resolve } from "node:path";          （import 区块）
#    ② baseURL: z.string(),                          （provider profile schema）
#    ③ var __disposeResources = (function (SuppressedError) {   （在其后插入 3、4）
#    ④ function profileOptions(profile, reasoning, apiKey) {    （第 5 项）
#    ⑤ ...profileOptions(profile, reasoning, apiKey),            （第 6 项）
#    ⑥ const adapter = new PiAiAdapter({
#         profiles,
#         resolveApiKey,                            （第 7 项）
#    ⑦ (await credentials.resolve(ref))?.value       （第 8 项）

# 4. 让 pnpm 重新应用补丁（必须带 --no-frozen-lockfile，patch_hash 会变）
pnpm install --no-frozen-lockfile

# 5. 校验补丁落地后重启
node --check "$f"
dsh web
```

### 怎么知道补丁还生效

补丁一旦失效，额度面板不再是一片空白，而是直接告警：

> ⚠ 额度观测未生效：当前 llm-pi-ai 未适配本插件（补丁未应用，或官方包升级后补丁已失效）。
> 账号切换仍然可用，但额度不会更新。

判据是宿主 `GET /api/codex-pool` 返回的 `integration` 字段 —— 插件自身就能分辨「还没请求过」
和「补丁没生效」，不需要去猜文件路径：

```jsonc
{
  "integration": {
    "hooked": true,        // 补丁调过 wrapFetch → 整条链路通了
    "stockAdapter": false  // 原版适配器解析凭据时不带 options；为 true 即未打补丁
  }
}
```

| `hooked` | `stockAdapter` | 含义 |
| --- | --- | --- |
| `true` | — | 补丁生效 |
| `false` | `true` | **补丁失效**，面板告警 |
| `false` | `false` | 还没发过请求，属于正常等待 |

## 边界

- 复用的是 Codex CLI 的登录凭据，不会导入 Codex 历史对话。
- 只支持文件型 `auth.json`；若 Codex 配置为仅存系统钥匙串，插件会明确报错。
- 额度状态保存在进程内存里，重启后从零开始观测。
- 这是本机可信插件：它与 Codex CLI 共享 refresh token，请勿安装到不可信 Harness profile。