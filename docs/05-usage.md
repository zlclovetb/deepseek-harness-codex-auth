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
npm test             # 运行 node --test（test/auth.test.js）
npm run pack:check   # 预览打包内容（npm pack --dry-run）
```

`npm test` 覆盖：未过期直接返回（无网络）、过期刷新并保留 auth 文档、只拦截目标引用
且 dispose 可还原、describe 报告只读状态。

## 3. 打包与安装

```powershell
npm pack
# 生成 deepseek-harness-codex-auth-<version>.tgz（当前 0.2.2）

dsh plugin --profile web add .\deepseek-harness-codex-auth-0.2.2.tgz
dsh --profile web --dump-config     # 确认 patch 已应用
dsh web                             # 启动
```

安装过程：

1. 包内 `dsh.bundle.patch` 指向 [cordis.patch.yml](../cordis.patch.yml)；
2. Harness 应用 patch：
   - 给官方 `llm-pi-ai` 增加 `providers.openai-codex`（`apiKeyEnv = OPENAI_CODEX_AUTH`）；
   - `insert` 插件 `id: codex-cli-auth` → 模块 `deepseek-harness-codex-auth`；
3. 重启后，在**模型选择器**中选择 `openai-codex` 下的模型即可。

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

## 5. 运行时行为速查

| 场景 | 行为 |
| --- | --- |
| 模型请求前解析凭据 | `llm-pi-ai` 调 `credentials.resolve("OPENAI_CODEX_AUTH", { proxyUrl })` |
| access token 未过期（> 5 分钟） | 直接读取返回，**无网络请求** |
| 剩余有效期 ≤ 5 分钟 | 触发 OAuth refresh，成功后原子写回 `auth.json` 并更新 `last_refresh` |
| 多个请求同时过期 | `refreshInflight` 去重，只刷新一次 |
| 与 Codex CLI 并发刷新 | 写回前比对 `refresh_token`，避免互相覆盖 |
| `auth.json` 缺失/不合法 | 报错提示 `run "codex login"`；`describe` 返回 `configured:false` |
| refresh 返回非 2xx | 抛 `Codex CLI token refresh failed (HTTP <status>)` |

**凭据只读**：`describe` 对 `OPENAI_CODEX_AUTH` 返回 `writable: false`，Harness UI 不允许编辑；
修改登录状态只能通过 `codex login`。

## 6. 可调环境变量

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | Codex 配置目录（决定 `auth.json` 位置） |
| `CODEX_REFRESH_TOKEN_URL_OVERRIDE` | `https://auth.openai.com/oauth/token` | 覆盖刷新端点 |
| `CODEX_APP_SERVER_LOGIN_CLIENT_ID` | `app_EMoamEEZ73f0CkXaXp7hrann` | 覆盖 OAuth client id |

## 7. 卸载

```powershell
dsh plugin --profile web remove deepseek-harness-codex-auth
```

卸载后 `apply` 返回的 dispose 会把 `credentials.resolve/describe` 还原为原始实现。

## 8. 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 报 `Cannot read Codex CLI login at …` | 未登录或 `CODEX_HOME` 不对 | 运行 `codex login`；核对 `CODEX_HOME` |
| 报 `has no ChatGPT OAuth tokens` | Codex 仅存系统钥匙串 / 登录非 ChatGPT 模式 | 改用文件型登录；当前不支持钥匙串 |
| 报 `token refresh failed (HTTP …)` | refresh token 失效 | 重新 `codex login` |
| 模型页无“网络代理”输入框 | 未应用官方包 patch，或不在 `openai-codex` 卡片 | 确认 patch 已随包分发并被 profile 应用 |
| 代理配置后仍超时 | 代理不支持 WebSocket 握手 | 将 provider `transport` 设为 `sse` |

## 9. 安全边界

- 本插件与 Codex CLI **共享 refresh token**，属于**本机可信插件**，请勿安装到不可信 Harness profile。
- token 只存在于 `auth.json`（`0o600`），不写入 Harness 配置或凭据库。
- 复用范围仅限**登录凭据**，不含 Codex 历史对话。