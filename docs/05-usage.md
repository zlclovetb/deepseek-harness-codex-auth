# 05 · 项目运行方式

## 1. 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | `>=22.19.0` |
| DeepSeek Harness | `>= 0.2.0-rc.2` |
| Codex CLI | 已完成 `codex login`，且登录写入**文件型** `auth.json` |
| Profile | Web（浏览器端 UI 依赖 `dsh.client.platform = web`） |

先确认 Codex 登录：

```powershell
codex login
codex login status
```

## 2. 开发与测试

```powershell
npm install          # 安装 undici
npm test             # 运行 node --test（test/auth.test.js、test/pool.test.js）
npm run pack:check   # 预览打包内容（npm pack --dry-run）
```

`npm test` 覆盖两个文件共 17 个用例（auth 4 + pool 13）：未过期直接返回（无网络）、过期刷新并保留 auth 文档、
只拦截目标引用且 dispose 可还原、describe 报告只读状态；以及账号发现（含单账号回退）、
额度响应头解析、hybrid 选择与限流跳过、窗口重置后重回轮换、`apply()` 端到端打桩与启动预热、
手动固定（含兜底与 prune 清理）、`wrapFetch` 观测额度且不改响应、面板经路由固定账号。

## 3. 打包与安装

```powershell
npm pack
# 生成 deepseek-harness-codex-auth-<version>.tgz（当前 0.4.2）

dsh plugin --profile web add .\deepseek-harness-codex-auth-0.4.2.tgz
dsh --profile web --dump-config     # 确认 patch 已应用
dsh web                             # 启动
```

安装过程：

1. 包内 `dsh.bundle.patch` 指向 [cordis.patch.yml](../cordis.patch.yml)；
2. Harness 应用 patch：
   - 给官方 `llm-pi-ai` 增加 `providers.openai-codex`（`apiKeyEnv = OPENAI_CODEX_AUTH`）；
   - `insert` 插件 `id: codex-cli-auth` → 模块 `deepseek-harness-codex-auth`；
3. 重启后，在**模型选择器**中选择 `openai-codex` 下的模型即可。

## 3.5 配置多账号（可选）

单账号沿用 `$CODEX_HOME/auth.json`，无需任何额外配置。要使用多账号，把每个登录放进
`<accountsDir>/<name>/auth.json`：

```powershell
# 账号 A
$env:CODEX_HOME = "$HOME\.codex\accounts\work"
codex login

# 账号 B
$env:CODEX_HOME = "$HOME\.codex\accounts\personal"
codex login

Remove-Item Env:\CODEX_HOME   # 恢复默认，供 DSH 使用
```

目录结构：

```text
$CODEX_HOME/                       # 默认 ~/.codex
├── accounts/
│   ├── personal/auth.json
│   └── work/auth.json
└── auth.json                      # 存在 accounts/ 子目录时不再使用
```

`accountsDir` 的解析优先级：插件配置 `accountsDir` → 环境变量 `CODEX_ACCOUNTS_DIR` →
默认 `$CODEX_HOME/accounts`。只要该目录下**存在任一子目录**就进入多账号模式；
不存在或为空则回退到单文件 `$CODEX_HOME/auth.json`（账号 id `default`）。

池参数（见 [cordis.patch.yml](../cordis.patch.yml)，均可在配置里覆盖）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `strategy` | `hybrid` | `hybrid`（剩余额度×健康分最优）/ `round-robin`（轮流）/ `sticky`（固定一个） |
| `quotaProbe` | `false` | 是否在请求前、以及启动预热时主动读一次 `chatgpt.com/backend-api/wham/usage` |
| `proxyUrl` | 直连 | 启动探测所用的代理，填与 provider 相同的地址（provider 走代理时必填，否则启动探测直连必然失败） |
| `rotateOnQuotaExhausted` | `true` | 设为 `false` 等价于 `strategy: sticky` |
| `accountsDir` | `$CODEX_HOME/accounts` | 账号目录 |

## 4. 配置网络代理（可选）

Web profile 若同时应用了补丁
[patches/@deepseek-ai__dsh-llm-pi-ai@0.2.0-rc.2.patch](../patches)，
模型页的 `openai-codex` 卡片会出现「网络代理」输入框：

1. 打开 设置 → 模型 → `openai-codex` 卡片；
2. 在“网络代理”填入形如 `http://127.0.0.1:7890` 的地址（留空为直连）；
3. 点“保存代理”，**重启 DSH 生效**。

> 该代理**仅作用于 openai-codex 这一个 provider**。
> 建议同时把该 provider 的 `transport` 设为 `sse`——不支持 WebSocket 的 HTTP 代理会先等待
> 握手指令直到超时。

代理配置落地位置：配置项 `providers["openai-codex"].proxyUrl`。

> 该补丁由 pnpm `patchedDependencies` 托管且 key 精确到版本，**官方包升级后会静默失效**；
> 重做步骤见 [README · 官方包补丁与升级适配](../README.md#官方包补丁与升级适配)。

## 4.5 查看多账号额度

同一个 `openai-codex` 卡片下方是「多账号额度」面板（同样需要已应用官方包补丁；未应用时面板会
直接告警而不是留空，见 [README](../README.md#怎么知道补丁还生效)）：

- 每 **15 秒**自动读取宿主的 `GET /api/codex-pool`（同源，无需额外配置）；
- 每个账号显示两条进度条——**5 小时窗口**与**本周窗口**——以及重置倒计时；
- 使用率 <80% 为正常色，≥80% 转警示色，≥100% 转错误色；角标显示
  「可用 / 冷却中 / 额度耗尽」；
- 插件在**启动时就后台预热账号池**，因此重启后打开设置页即可看到全部账号（无需先发起对话）；
  每个账号的**额度数值**要等它发过请求（被动观测）或开启 `quotaProbe`（启动时主动探测）后才出现，
  此前该行显示「暂无数据」。

> **开了 `quotaProbe` 却仍是「暂无数据」？** 多半是启动探测没走代理。适配器只在解析凭据时才把
> `providers["openai-codex"].proxyUrl` 交出来，而启动探测在此之前就要访问 `chatgpt.com`——所以
> **插件配置里要再填一次同样的 `proxyUrl`**（见 [§3.5 池参数](#35-配置多账号可选)）。不填时启动探测
> 只能直连，在必须走代理的网络里必然超时；此时发一次对话仍会被动补探成功。

面板不可用时（例如无头部署没有 `webServer`）只影响展示，不影响轮换本身。

## 4.6 手动切换账号

默认按 `strategy` 自动选择。要让某个账号一直用，直接在面板里指定：

1. 在账号行右侧点「用此账号」→ 该行出现「已固定」标记，标题栏出现「恢复自动」；
2. 想交还给自动选择，点「恢复自动」（或该行的「取消固定」）。

规则：

- 切换**从下一个请求开始**生效，不会打断正在生成的回答；
- 固定是**兜底式**的：被固定的账号额度耗尽或冷却中时，会临时回退到 `strategy` 选择的账号，
  面板提示「已临时回退到自动选择」；它的窗口一重置就自动回到该账号；
- 固定状态**只存在于进程内**，重启 DSH 后回到自动选择；想长期固定账号请改用
  `strategy: sticky` 或给不同用途配置不同的 `accountsDir`。

## 5. 运行时行为速查

| 场景 | 行为 |
| --- | --- |
| 模型请求前解析凭据 | `llm-pi-ai` 调 `credentials.resolve("OPENAI_CODEX_AUTH", { proxyUrl })` |
| 账号发现 | 有 `accounts/<name>/auth.json` 子目录 → 成池；否则回退单文件（id `default`） |
| access token 未过期（> 5 分钟） | 直接读取返回，**无网络请求** |
| 剩余有效期 ≤ 5 分钟 | 触发 OAuth refresh，成功后原子写回该账号 `auth.json` 并更新 `last_refresh` |
| 多个请求同时过期 | `refreshInflight` 按文件路径去重，只刷新一次 |
| 与 Codex CLI 并发刷新 | 写回前比对 `refresh_token`，避免互相覆盖 |
| 插件启动后 | 后台预热账号池，面板立即列出全部账号；`quotaProbe: true` 时同时主动探一次各账号额度 |
| 响应携带额度头 | `wrapFetch` 观测后合并进该账号的 5 小时 / 本周窗口 |
| 某账号 5 小时或本周窗口达 100% | 冷落到该窗口重置时间，**下一个请求**切到别的账号 |
| 某账号返回 429 | 记失败并冷落；额度窗口已表达限流，不再额外扣健康分 |
| 某账号连续 5xx | 健康分 ×0.7，冷却 30 秒后重新参与选择 |
| 某账号 `auth.json` 读不到 / 刷不动 | 冷落 30 秒并尝试下一个账号；全部失败才抛错 |
| 面板里固定了某账号 | 下次选择优先用它；它耗尽或冷却时临时回退到 `strategy`，窗口重置后自动回归 |
| 开启了 `quotaProbe` | 在交出请求前异步探一次额度，结果**不影响**本次请求 |
| `auth.json` 缺失/不合法 | 报错提示 `run "codex login"`；`describe` 返回 `configured:false` |
| refresh 返回非 2xx | 抛 `Codex CLI token refresh failed (HTTP <status>)` |

**切换粒度**：额度耗尽后**不会**在同一次请求内重放——复用同一 prompt 的第二个请求才会换账号，
避免把一次用户操作放大成多次调用。

**凭据只读**：`describe` 对 `OPENAI_CODEX_AUTH` 返回 `writable: false`，Harness UI 不允许编辑；
修改登录状态只能通过 `codex login`。

**进程内存**：额度、健康分、冷却与**手动固定**全部只存在于当前进程，重启后从零开始重新观测。

## 6. 可调环境变量

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | Codex 配置目录（决定 `auth.json` 位置） |
| `CODEX_ACCOUNTS_DIR` | `<CODEX_HOME>/accounts` | 多账号目录（低于插件配置 `accountsDir`） |
| `CODEX_REFRESH_TOKEN_URL_OVERRIDE` | `https://auth.openai.com/oauth/token` | 覆盖刷新端点 |
| `CODEX_APP_SERVER_LOGIN_CLIENT_ID` | `app_EMoamEEZ73f0CkXaXp7hrann` | 覆盖 OAuth client id |

## 7. 卸载

```powershell
dsh plugin --profile web remove deepseek-harness-codex-auth
```

卸载后 `apply` 返回的 dispose 会：注销 `/api/codex-pool` 路由、撤销 `codexMultiAuth` 服务、
还原 `credentials.resolve/describe` 为原始实现。

## 8. 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 报 `Cannot read Codex CLI login at …` | 未登录或 `CODEX_HOME` 不对 | 运行 `codex login`；核对 `CODEX_HOME` |
| 报 `has no ChatGPT OAuth tokens` | Codex 仅存系统钥匙串 / 登录非 ChatGPT 模式 | 改用文件型登录；当前不支持钥匙串 |
| 报 `Codex CLI pool at … has no usable login` | 池里每个账号都读不到或刷不动 | 对各账号分别 `codex login`；核对 `accountsDir` |
| 报 `token refresh failed (HTTP …)` | 该账号 refresh token 失效 | 对该账号重新 `codex login` |
| 模型页无“网络代理”输入框 | 未应用官方包 patch，或不在 `openai-codex` 卡片 | 确认 patch 已随包分发并被 profile 应用（重做步骤见 [README](../README.md#官方包补丁与升级适配)） |
| 代理配置后仍超时 | 代理不支持 WebSocket 握手 | 将 provider `transport` 设为 `sse` |
| 额度面板显示「多账号额度不可用」 | 当前运行环境没有 `webServer`（无头部署），或路由未注册 | 属预期降级；不影响轮换 |
| 额度面板显示「额度观测未生效」 | `GET /api/codex-pool` 的 `integration.hooked === false` 且 `stockAdapter === true`，即官方包未被补丁 | 按 [README](../README.md#官方包补丁与升级适配) 重做补丁；期间账号轮换仍可用，但感知不到额度 |
| 面板提示「尚未列出账号」 | 账号预热尚未完成，或 `accountsDir` 下确无登录 | 稍候片刻即出现；若持续为空，确认 `$CODEX_HOME/accounts/<name>/auth.json` 存在 |
| 重启后账号已出现但额度全是「暂无数据」 | 账号只被列出、尚未发过请求（被动观测无读数） | 属预期；开启 `quotaProbe: true` 让启动时主动探测，或先发一次对话 |
| 开了 `quotaProbe` 但额度仍全是「暂无数据」 | provider 走代理，而插件配置没填 `proxyUrl`，启动探测直连 `chatgpt.com` 超时 | 在插件配置里填与 provider 相同的 `proxyUrl` 后重启；或先发一次对话（首个请求会带代理补探） |
| 面板只显示一个账号 | `accountsDir` 下没有子目录，走了单文件回退 | 检查 `$CODEX_HOME/accounts/<name>/auth.json` 是否存在 |
| 点了「用此账号」提示「切换账号失败」 | `POST /api/codex-pool` 返回 4xx/5xx（例如该账号已从池中消失 → 404） | 在浏览器网络面板看该请求的状态码与 `{ error }` 响应体 |
| 固定了账号却走了别的账号 | 该账号耗尽或冷却中，固定让位给兜底 | 面板会提示「已临时回退到自动选择」，属预期；等它的窗口重置 |
| 重启后固定失效 | 固定只存于进程内存 | 属预期；需要长期固定请用 `strategy: sticky` |
| 账号额度全满却仍不切换 | 后端未返回额度响应头，且未开 `quotaProbe` | 打开 `quotaProbe: true` 主动探测 |

## 9. 安全边界

- 本插件与 Codex CLI **共享 refresh token**，属于**本机可信插件**，请勿安装到不可信 Harness profile。
- token 只存在于各账号的 `auth.json`（`0o600`），不写入 Harness 配置或凭据库。
- `/api/codex-pool` **只返回用量百分比、重置时间与健康分**，不含任何 token、邮箱或账号 id 之外的凭据；
  该路由不额外鉴权，依赖 `webServer` 自身的监听地址（默认仅本机回环）。它的 `POST` 只能改
  **内存里的账号选择**（`{ pin }`），既不读写凭据文件，也不改配置。
- 复用范围仅限**登录凭据**，不含 Codex 历史对话。