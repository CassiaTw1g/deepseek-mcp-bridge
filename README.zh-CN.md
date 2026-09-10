# deepseek-mcp-bridge

把 **DeepSeek** 包装成一个 MCP 工具,供 ChatGPT connector(以及任何 MCP 客户端)调用。

[English](README.md) · [更新日志](CHANGELOG.md) · [贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md)

---

## 为什么需要它

ChatGPT 的子代理槽位只接受 OpenAI 自家的模型档位(Sol / Terra / Luna),外部模型无法注册成子代理。引入外部模型的唯一入口是 **MCP connector**——把它包成一个主代理可以调用的**工具**。

这意味着一些必须接受的语义变化:

| | ChatGPT 原生子代理 | 本桥接(DeepSeek 作为工具) |
|---|---|---|
| 独立上下文 | 是 | 是(它只看到你传进去的 prompt) |
| 独立性来源 | 独立会话,但同属 OpenAI 栈 | **不同厂商、不同模型,真正独立** |
| 并行 | 是 | 否,同步请求/响应 |
| 结果去向 | 留存于独立会话 | 回到调用方上下文 |
| 成本 | 订阅 credits | 走 DeepSeek API,独立计费(极便宜) |

主要收益是**跨厂商独立复核**。如果你的提示词要求审查者**不得复用**实现者的结论,那么来自不同厂商的模型比同一技术栈的另一档位更符合这条要求——不存在共享的训练血脉去附和。

> 本桥接是一个独立的 Node 进程,**不运行在** Claude Code、ChatGPT 或任何宿主里——它只与 `api.deepseek.com` 通信。

## 架构

```
ChatGPT (Sol)  ──HTTPS──▶  Cloudflare 边缘  ──隧道──▶  本桥接 (localhost:8787)  ──▶  api.deepseek.com
     │                                                                                     │
     └── 工具调用: deepseek_flash(task, mode, files) ── 文本结果回到 Sol 上下文 ◀────────────┘
```

- **传输**:MCP Streamable HTTP,无状态(`sessionIdGenerator: undefined`,每个请求新建 server + transport,调用方之间不串数据)。
- **响应以 SSE 流式返回**,而不是缓冲成 JSON。这能让字节持续在链路上流动,避免 Cloudflare 免费版对长 DeepSeek 调用报 **524** 超时。
- **鉴权**:能力 URL。MCP 端点是 `/mcp/<64 位 hex 密钥>`,**路径本身就是凭证**。裸 `/mcp` 和任何错误路径都返回 **404**,与"这里什么都没有"不可区分——因为 ChatGPT 的 connector 表单**没有填 Bearer token 的字段**。

## 环境要求

- Node.js **>= 24**(使用原生 TypeScript 类型剥离,无需构建步骤)
- 一个 DeepSeek API key——在 <https://platform.deepseek.com> 申请
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)(快速隧道用;也可自行部署,见下文)

## 快速开始

```bash
git clone https://github.com/CassiaTw1g/deepseek-mcp-bridge.git
cd deepseek-mcp-bridge
npm install
cp .env.example .env
```

编辑 `.env`:

1. 把 `DEEPSEEK_API_KEY` 填成你的 key。**给这个桥单独申请一个 key**,以便独立撤销;并在 DeepSeek 控制台给它设置消费上限,作为最后一道防线。
2. 生成路径密钥:

   ```bash
   npm run ctl -- secret
   ```

   这会把 `MCP_PATH_SECRET=<随机 hex>` 写进 `.env`(若 `.env` 不存在则直接打印)。

启动服务并开隧道:

```bash
npm run start     # 后台服务,监听 127.0.0.1:8787
npm run tunnel    # cloudflared 快速隧道;打印公网 URL 和完整的 MCP 端点
```

`npm run tunnel` 会打印出可直接填进 ChatGPT 的 URL:

```
公网端点 : https://<random>.trycloudflare.com/mcp/<your-secret>
```

### 注册 connector

1. 打开 **ChatGPT 网页版**(桌面端/移动端设置不了 connector)。
2. **Settings → Plugins → MCP → Add server**(备选入口:Settings → Connectors → Advanced → Developer mode)。
3. 类型:**Streamable HTTP**;鉴权:**No authentication**。
4. URL:填**完整**的 `https://<random>.trycloudflare.com/mcp/<your-secret>`——必须包含 `/mcp/<secret>` 路径。只填域名不行。
5. 保存。握手成功的标志是日志出现 `server/discover → initialize → notifications/initialized → tools/list`。

### 告诉主代理什么时候该用它

工具 description 就是路由依据。它写的是**派发条件**,而不仅是工具功能——这能避免调用方随意选择。在你的系统提示词里补一条与你现有子代理规则**互斥**的规则,例如:

> 需要跨厂商独立复核的任务(安全审查、反例构造)→ 调用 `deepseek_flash` 工具,不要派给子代理。需要读写文件、并行协作或与实现者同栈的任务 → 派给子代理。

## 工具参考

只暴露**一个**工具。工具越少,路由错误越少。

### `deepseek_flash`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `task` | string | 是 | 具体任务。写清目标、约束、期望的输出格式。独立复核场景下**不要在此透露你自己的结论**——那会污染独立性。 |
| `mode` | enum | 否 | `analyze` \| `review` \| `code` \| `summarize`,选择系统提示词。默认 `analyze`。 |
| `files` | string | 否 | 要分析/审查的代码或文本,纯文本透传。本桥接**无法访问你的文件系统**——内容必须贴在这里。 |

每个 `mode` 有独立的系统提示词。`review` 明确要求模型把材料中作者的结论视为**未经证实的声明**,并显式列出不同意之处——这正是把它路由到外部厂商的意义所在。

## 配置

全部通过 `.env`(已被 gitignore):

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | **必填。** 用专用 key,并设消费上限。 |
| `MCP_PATH_SECRET` | — | **必填**,至少 16 字符。能力路径段。`npm run ctl -- secret` 生成 32 字节 hex。 |
| `PORT` | `8787` | 本地监听端口。 |
| `HOST` | `127.0.0.1` | 监听地址。**保持回环**——隧道跑在同一台机器上,把端口暴露到局域网没有任何好处。 |
| `RATE_LIMIT_PER_MINUTE` | `20` | 每 IP 滑动窗口。URL 泄漏时限制爆炸半径。 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容端点。 |
| `DEEPSEEK_MODEL` | `deepseek-flash` | 模型 ID。 |
| `DEEPSEEK_TIMEOUT_MS` | `90000` | 服务端超时;返回结构化错误而不是挂住。保持在 Cloudflare 100 秒边缘超时以下。 |
| `DEEPSEEK_MAX_OUTPUT_TOKENS` | `4096` | 输出上限。`deepseek-flash` 是推理模型:`reasoning_content` 与 `content` **共享**这个预算,过度推理会挤掉正文。 |

## 生命周期命令

```bash
npm run start      # 后台启动(已运行则无操作)
npm run stop       # 停止服务和隧道
npm run restart    # 重启服务(会一并停掉隧道,需重新 tunnel)
npm run status     # 启用状态、PID、本地与公网端点
npm run logs       # 最近 40 行日志
npm run tunnel     # 启动 Cloudflare 隧道并打印公网 URL
npm run untunnel   # 只停隧道
npm run enable     # 清除 disabled 标志
npm run disable    # 停止一切并设置 disabled 标志
npm run uninstall  # 停止并清除本地状态(保留项目目录)
```

`npm run start --foreground` 前台运行,便于调试。

## 验证

三层,从最便宜的开始。

**1. 内存传输自检——不需要网络和 key:**

```bash
npm test              # typecheck + 内存内 MCP 往返
```

**2. 公网端点冒烟测试——走真实 HTTP 链路:**

```bash
npm run smoke                          # 从 .state/tunnel.log 读隧道 URL
npm run smoke -- https://host/mcp/xxx  # 或显式传入端点
```

它断言:健康检查正常、裸 `/mcp` 返回 404、错误密钥返回 404、真实 `tools/call` 返回非空内容。它用 Node 的 `fetch`,**不是 `curl`**——原因见下面的 Windows 说明。

**3. ChatGPT 到底有没有调用?**

服务端访问日志和聊天记录长得一模一样——无论模型是真的调了工具,还是只是**叙述**它调了。唯一可信的信号是:

- `npm run logs` 里的 `tools/call deepseek_flash` 日志行,以及
- DeepSeek 控制台用量页面对应的记录。

如果聊天里出现了像模像样的回答,但**两者都**安静,那说明调用模型在角色扮演。回去打磨工具 description 或你的派发规则。

## 部署方式

快速隧道适合起步,但它的 URL 每次重启都会变(必须重新编辑 connector)。长期使用:

| 选项 | 成本 | 何时选 |
|---|---|---|
| **cloudflared 快速隧道** | 免费 | 首次运行、验证。在 QUIC 被封的网络下必须加 `--protocol http2`。 |
| **Cloudflare Worker** | 免费 | URL 固定、无本地进程。把传输层改写到 Hono 的 Web Standard 变体;DeepSeek key 存 Worker secret。 |
| **VPS(HK / SG)** | 约 $5–12/月 | 长期稳定,且 100 秒边缘超时完全消失。 |

排除 ngrok 免费版:它的插页警告页需要 `ngrok-skip-browser-warning` 请求头,而 ChatGPT connector 无法自定义请求头,会掐断连接。

## 故障排查

| 症状 | 原因 / 处理 |
|---|---|
| 启动时报 `MCP_PATH_SECRET 未设置或过短` | 运行 `npm run ctl -- secret` 写入 `.env`。 |
| ChatGPT 显示无法连接 | URL 必须包含完整的 `/mcp/<secret>` 路径。用 `npm run status` 查看当前公网端点。 |
| 公网 URL 返回 404 | 密钥错误或已过期。轮换后需重启,并同步更新 connector URL。 |
| DeepSeek 回复空白 | `deepseek-flash` 偶尔只输出推理内容,`content` 为空。桥接会自动重试一次;若仍失败,调高 `DEEPSEEK_MAX_OUTPUT_TOKENS` 或把任务拆小。 |
| 回答被截断 | 推理占满了 token 预算(`finish_reason: "length"`)。调高上限或缩小任务。 |
| Cloudflare 524 | 单次调用超过约 100 秒边缘超时。慢响应已走 SSE 流式;降低 `DEEPSEEK_TIMEOUT_MS` 或拆分任务。 |
| 本机访问不了隧道 URL | 本地路由器 DNS 可能还没解析到新的 `trycloudflare.com` 子域。用 `curl --resolve` 对 `1.1.1.1` 验证;这只影响本地检查,不影响 ChatGPT。 |
| **Windows / git-bash**:结果乱码或 token 暴涨 | git-bash 里的 `curl` 会把非 ASCII 请求体重编码成 GBK,导致模型对乱码进行推理。改用 `npm run smoke`(Node `fetch`),不要用 `curl`。 |

## 安全模型

暴露到公网前请务必阅读。

- **路径密钥就是凭证。** 拿到 URL 的任何人都能花你的 DeepSeek 额度。当作密码对待;用 `npm run ctl -- secret` 轮换。
- **绑定回环地址。** `HOST` 默认 `127.0.0.1`。不要设成 `0.0.0.0`。
- **限流**默认开启,URL 泄漏时限制滥用。
- **DeepSeek 消费上限**是最后一道防线——去控制台设上。
- **使用独立的 API key。** 不要复用其他工具依赖的 key;桥接 key 泄漏时应能独立撤销而不产生连带损失。
- 本工具是**只读**的:只返回文本,无文件系统访问。

上报漏洞请见 [SECURITY.md](SECURITY.md)。

## 许可

[MIT](LICENSE)
