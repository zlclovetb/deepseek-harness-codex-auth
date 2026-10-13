# deepseek-harness-codex-auth

让 DeepSeek Harness 的官方 `llm-pi-ai` 适配器直接复用 Codex CLI 的 ChatGPT 登录。

插件只拦截 `OPENAI_CODEX_AUTH` 这一条凭据引用：设置页显示 Codex CLI 的只读登录状态，每次模型请求读取
`$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`），access token 即将过期时按
Codex CLI 的协议刷新并写回同一文件。token 不会复制到 Harness 配置或凭据文件。

## 安装

要求 Node.js `>=22.19.0`、DeepSeek Harness `0.2.0-rc.2`，以及已完成：

```powershell
codex login
codex login status
```

在本仓库打包并安装到 Web profile：

```powershell
npm test
npm pack
dsh plugin --profile web add .\deepseek-harness-codex-auth-0.2.2.tgz
dsh --profile web --dump-config
dsh web
```

Bundle patch 会保留官方 `llm-pi-ai`，只加入 `openai-codex` 路由和认证桥。重启后在
模型选择器中选择 `openai-codex` 下的模型。

Web profile 同时应用 `patches/@deepseek-ai__dsh-llm-pi-ai@0.2.0-rc.2.patch` 后，模型页的
`openai-codex` 卡片会出现“网络代理”输入框。该代理只用于此 provider；建议同时把
`transport` 设为 `sse`，避免不支持 WebSocket 的 HTTP 代理先等待握手超时。

卸载：

```powershell
dsh plugin --profile web remove deepseek-harness-codex-auth
```

## 边界

- 复用的是 Codex CLI 的登录凭据，不会导入 Codex 历史对话。
- 当前只支持文件型 `$CODEX_HOME/auth.json`；若 Codex 配置为仅存系统钥匙串，插件会明确报错。
- 这是本机可信插件：它与 Codex CLI 共享 refresh token，请勿安装到不可信 Harness profile。
