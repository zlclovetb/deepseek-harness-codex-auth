# Code Wiki — deepseek-harness-codex-auth

DeepSeek Harness 插件：让官方 `llm-pi-ai` 适配器直接复用 **Codex CLI** 的 ChatGPT 登录凭据，
无需把 access token 复制到 Harness 配置中；支持**多个 Codex 账号**按额度自动轮换。

本 Wiki 面向需要理解、维护或二次开发该插件的工程师。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [01-architecture.md](./01-architecture.md) | 整体架构、运行时数据流、插件生命周期、关键设计约束 |
| [02-modules.md](./02-modules.md) | 各文件（服务端 / 浏览器端 / 补丁 / 测试）的职责边界 |
| [03-api-reference.md](./03-api-reference.md) | 关键常量、函数、导出符号、配置项的逐条说明 |
| [04-dependencies.md](./04-dependencies.md) | npm 依赖、宿主服务依赖、peer 依赖与版本约束 |
| [05-usage.md](./05-usage.md) | 环境要求、打包安装、配置、运行、测试与卸载 |

## 一分钟概览

- **插件名**：`deepseek-harness-codex-auth`（Cordis 插件 id：`codex-cli-auth`）
- **运行时**：Node.js `>=22.19.0`，ESM（`"type": "module"`）
- **入口**：
  - 服务端：[index.js](../index.js)
  - 浏览器端：[client.js](../client.js)
- **核心机制**：拦截名为 `OPENAI_CODEX_AUTH` 的**单条**凭据引用，改为实时读取
  `$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`），必要时按 Codex CLI 协议刷新并原子写回。
- **账号池**：`$CODEX_HOME/accounts/<name>/auth.json` 存在时按多个账号轮换；额度取自响应头（被动），
  亦可选主动读取（`quotaProbe: true`：订阅优先 + 拉取兜底，节奏由服务端 `renewal_seconds` 租期决定）；
  插件**启动即后台预热**，面板无需先对话即可列出账号，**打开面板会强制重读全部账号**（此时若 provider
  走代理，插件配置里也要填同样的 `proxyUrl`），面板里还可手动固定某个账号（兜底式、仅进程内）。
  无该目录时回退到单账号，行为与旧版一致。
- **依赖**：仅一个运行时依赖 `undici`；其余能力（`credentials` / `slots` / `configForms` /
  `webServer`）由宿主 DeepSeek Harness 注入。

## 快速定位

| 想了解 | 去哪里 |
| --- | --- |
| token 怎么读、怎么刷新、怎么避免并发重复刷新 | [03-api-reference.md](./03-api-reference.md#resolvecodexcredential) |
| `apply(ctx)` 如何打桩 `credentials` | [03-api-reference.md](./03-api-reference.md#applyctx-config) |
| 多账号怎么发现、怎么挑、额度怎么记 | [03-api-reference.md](./03-api-reference.md#lib-账号池) |
| 「额度面板」的数据从哪来 | [03-api-reference.md](./03-api-reference.md#quotapanelprovider) |
| 怎么手动指定用哪个 Codex 账号 | [05-usage.md](./05-usage.md#46-手动切换账号) · [03-api-reference.md](./03-api-reference.md#pinid) |
| 重启后账号/额度多久出现（启动预热） | [03-api-reference.md](./03-api-reference.md#warm) · [05-usage.md](./05-usage.md#45-查看多账号额度) |
| 开了 `quotaProbe` 额度还是不更新 | [05-usage.md](./05-usage.md#8-故障排查)（多半是没给插件配置填 `proxyUrl`） |
| `cordis.patch.yml` 如何注册路由与桥接 | [02-modules.md](./02-modules.md#cordispatchyml--bundle-patch) |
| 设置页“网络代理”输入框怎么来的 | [02-modules.md](./02-modules.md#clientjs--浏览器端模块) |
| `proxyUrl` 补丁改了官方包的哪些地方 | [04-dependencies.md](./04-dependencies.md#5-补丁patch详解) |
| 官方包升级后补丁怎么重做 | [README.md](../README.md#官方包补丁与升级适配) |
| 面板显示「额度观测未生效」怎么办 | [README.md](../README.md#怎么知道补丁还生效) |
| 怎么安装、跑测试、卸载 | [05-usage.md](./05-usage.md) |