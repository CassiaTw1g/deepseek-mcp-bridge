/**
 * The pure half of `npm run setup` — the first-run wizard.
 *
 * Everything here is deterministic and side-effect free: text, language
 * detection, URL building, and the reading of a probe response. The wizard
 * itself lives in `ctl.mjs`, because that is where `ask`, `writeEnvKey`,
 * `mask`, `cmdStart` and `cmdTunnel` already are, and re-implementing any of
 * them would be how two copies of a security rule drift apart.
 *
 * It is a separate module for one reason: `ctl.mjs` runs its `switch` at import
 * time, so a test cannot import it. The parts of the wizard that can be *wrong*
 * in a way nobody notices — a URL that gets `/v1` twice, a 404 reported as a
 * bad key, a missing translation — are all here, where `npm test` can reach
 * them.
 */

export const LANGS = ["zh", "en"];

/**
 * `zh-CN`, `zh_TW`, `zh-Hans-CN` → `zh`. Returns null for anything we do not
 * speak, so the caller can tell "no opinion" from "an explicit choice".
 */
export function normalizeLang(value) {
  const tag = String(value ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (!tag) return null;
  const primary = tag.split("-")[0];
  return LANGS.includes(primary) ? primary : null;
}

/**
 * Which language to speak.
 *
 * Explicit beats environment beats the machine's own locale, and English is the
 * floor. The locale fallback is what makes one command serve both audiences:
 * on a Chinese Windows this opens in Chinese, on a GitHub cloner's machine in
 * English, and `--lang` overrides either.
 */
export function detectLang({ explicit, env, locale } = {}) {
  return (
    normalizeLang(explicit) ?? normalizeLang(env) ?? normalizeLang(locale) ?? "en"
  );
}

const MESSAGES = {
  zh: {
    "banner.title": "ModelBridge 首次安装向导",
    "banner.intro": [
      "这个向导会把 .env 问出来、写好,再把服务和隧道起来,最后给你要填进",
      "ChatGPT 的那个地址。",
      "",
      "· 全程只认你敲进去的回答,不猜、不联网查你的机器。",
      "· 密钥只写进 .env,屏幕上不会打印出来。",
      "· 中途 Ctrl+C 可以退出,已经写好的部分会留下,下次接着跑。",
    ],

    "dep.title": "准备:依赖",
    "dep.found": "node_modules 已经在了,跳过。",
    "dep.missing": [
      "还没装依赖(express / zod / MCP SDK 等)。这一步要联网,大概一两分钟。",
      "向导本身不需要它们,所以你现在看到的是它 —— 但服务需要。",
    ],
    "dep.ask": "现在装吗?(Y/n,默认 Y)",
    "dep.running": "正在跑 npm install …",
    "dep.failed": [
      "npm install 失败了。多半是网络(国内直连 npm 经常超时),试试:",
      "  npm config set registry https://registry.npmmirror.com",
      "然后重新跑 npm run setup。",
    ],
    "dep.skipped": "跳过了。服务起不来,后面那步会失败 —— 到时候再装也行。",

    "q.model.title": "[1/5] 用哪个模型?",
    "q.model.explain": [
      "桥接的「大脑」可以是任何说 Anthropic 接口的模型,不一定是 DeepSeek。",
      "DeepSeek 只是默认值:便宜、够用,而且和 ChatGPT 不同厂商 —— 做独立复核时",
      "不带同源偏置。",
    ],
    "q.model.option1": "DeepSeek(默认,https://api.deepseek.com)",
    "q.model.option2": "其它 Anthropic 兼容端点(自己填地址和模型名)",
    "q.model.choose": "选一个(默认 1):",
    "q.model.base": "端点的 base URL(形如 https://api.example.com,不要带 /anthropic、不要带 /v1):",
    "q.model.baseBad": "这不像一个 http(s) 地址。",
    "q.model.baseStripped": "结尾的 /anthropic 去掉了 —— 那一层由桥接自己加,不用你写。",
    "q.model.model": "模型名(例如 deepseek-flash):",
    "q.model.modelBad": "模型名不能是空的。",
    "q.model.apikey": "把 API key 粘进来(输入时不回显):",
    "q.model.apikeyEmpty": "没读到 key。",
    "q.model.apikeyShape": "注意:这把 key 不是 sk- 开头。DeepSeek 的 key 都是 sk- 开头,别家的不一定 —— 如果确定没粘错就继续。",
    "q.model.probing": "正在用一个极小的请求验证它(几个 token,基本不花钱)…",
    "q.model.ok": "✅ 通了:{model} 正常应答。",
    "q.model.badKey": "❌ 端点拒绝了这把 key(HTTP {status})。多半是复制少了字符,或者这把 key 已经被吊销。",
    "q.model.badBase": "❌ HTTP 404。端点和 key 里,至少有一个不对 —— 404 通常是地址问题(比如少了一段路径)。",
    "q.model.badRequest": "❌ HTTP {status}。地址和 key 都通了,但对方不接受这个请求 —— 最常见的是模型名不认识:{model}。",
    "q.model.rateLimited": "⚠️ HTTP 429:key 是通的,只是现在被限流。可以继续。",
    "q.model.server": "❌ HTTP {status}:对方服务端出错,不是你的配置问题。过一会儿再试。",
    "q.model.network": "❌ 连不上这个地址:{detail}",
    "q.model.unknown": "❌ HTTP {status}。",
    "q.model.detail": "   对方原话:{detail}",
    "q.model.retry1": "重填一遍(地址、模型名、key 都重新问)",
    "q.model.retry2": "就这样保存,先不管",
    "q.model.retry3": "退出向导",
    "q.model.saved": "已写入 .env:DEEPSEEK_API_KEY=<已隐藏,{length} 个字符>",
    "q.model.savedAnyway": "已照原样写入 .env —— 后面调不通的话,回来重跑 npm run setup。",

    "q.harness.title": "[2/5] 模型在哪个 harness 上跑?",
    "q.harness.explain": [
      "harness 是真正干活的那个执行器:工具(读写文件、执行命令)、多步循环、",
      "上下文压缩、审批,都是它提供的。模型只是它的「大脑」。",
      "",
      "这个项目目前只实现了一个 harness:Claude Code。上面那个模型换上之后,",
      "Claude Code 就变成一个壳子 —— 循环和工具还是它的,但每次推理都打到你自己",
      "填的那个端点,不花 Anthropic 一分钱。",
      "",
      "所以这一步没有选项可言,只需要确认它在这台机器上找得到。",
    ],
    "q.harness.found": "✅ 找到 Claude Code:{path}",
    "q.harness.missing": [
      "❌ 没找到 Claude Code。只装模型不装它的话,只有 deepseek_flash(一问一答)",
      "   能用,那两个 agent 工具会全部失败。",
      "",
      "   装:npm i -g @anthropic-ai/claude-code",
      "   装完还找不到?把可执行文件的完整路径填到下面,或者手动写进 .env 的",
      "   BRIDGE_CLAUDE_BIN。",
    ],
    "q.harness.askPath": "Claude Code 的完整路径(不确定就按回车跳过):",
    "q.harness.pathSaved": "已写入 .env:BRIDGE_CLAUDE_BIN={path}",
    "q.harness.pathBad": "这个文件不存在,没写:{path}",
    "q.harness.skip": "跳过 —— 等你装好了再说。",

    "q.roots.title": "[3/5] 子代理能在哪些目录里工作?",
    "q.roots.explain": [
      "留空 = 拒绝一切路径,桥就是只读的:只能问答,碰不到你的文件。",
      "",
      "填了就等于把这些目录交出去 —— 拿到那个公网 URL 的人可以在里面读文件、",
      "改文件、执行命令。「能执行命令」等于「拿到这台电脑」。",
      "",
      "想先试问答那一档,直接回车跳过。以后随时能加:npm run ctl -- allow \"D:\\项目\"",
    ],
    "q.roots.ask": "要交给它的目录(回车 = 跳过):",
    "q.roots.danger": "拒绝:{path} 是{what},等于把整台机器交出去。填一个具体的项目目录。",
    "q.roots.notfound": "这个路径不存在,没写:{path}",
    "q.roots.added": "已写入 .env:DEEPSEEK_ALLOWED_ROOTS={roots}",
    "q.roots.skip": "保持只读。",
    "q.roots.keep": "没加新的。原来已经配了这些,继续生效:{roots}",
    "q.roots.warn": "⚠️  拿到 URL 的人现在可以在上面这些目录里读写文件、执行命令。",

    "q.tunnel.title": "[4/5] 公网地址用临时域名还是固定域名?",
    "q.tunnel.explain": [
      "ChatGPT 要够得着这台机器,中间必须有一条 Cloudflare 隧道。两种:",
      "",
      "  1) 临时隧道(默认)—— 零配置,但每次启动都换一个随机域名;",
      "     换了就得回 ChatGPT 把 connector 的 URL 改一次。",
      "  2) 固定域名 —— 用你自己的域名,地址永远不变,connector 只建一次。",
      "     前提:这个域名的 NS 已经指向 Cloudflare,否则控制台那步加不了。",
    ],
    "q.tunnel.option1": "临时隧道(默认)",
    "q.tunnel.option2": "固定域名(需要你自己的域名 + Cloudflare)",
    "q.tunnel.choose": "选一个(默认 1):",
    "q.tunnel.host": "你的域名(形如 mcp.example.com,不要带 https://):",
    "q.tunnel.hostBad": "\"{host}\" 看着不像域名。要形如 mcp.example.com。",
    "q.tunnel.tokenExplain": [
      "需要一个隧道 token,在 Cloudflare 控制台拿:",
      "  Zero Trust → Networks → Tunnels → Create a tunnel → 选 Cloudflared",
      "  创建后页面上会给一串很长的 token(如果这条隧道已经建好了:点进去 →",
      "  Configure → 也能看到)。",
    ],
    "q.tunnel.tokenAsk": "把 token 粘进来(输入时不回显):",
    "q.tunnel.tokenShort": "只有 {n} 个字符,不像完整的 token(通常 150 以上)。多半是复制少了。",
    "q.tunnel.saved": "已写入 .env:TUNNEL_MODE=named / TUNNEL_HOSTNAME={host} / TUNNEL_TOKEN=<已隐藏>",
    "q.tunnel.dnsNote": [
      "⚠️  还有一步只能在 Cloudflare 网页上做,本机做不了:",
      "     Zero Trust → Networks → Tunnels → 这条隧道 → Public Hostname → Add",
      "     子域名 {sub} / 域 {domain} / Service 选 HTTP / URL 填 localhost:{port}",
      "   漏了它:隧道会显示「已连上边缘」,但打开那个域名是 404。",
      "   做完用 npm run ctl -- tunnel check 核对。",
    ],
    "q.tunnel.quick": "用临时隧道。这次启动拿到的域名写在下面 —— 重启会变,变了就 npm run ctl -- url 重拿一次。",

    "q.approval.title": "[5/5] 子代理执行命令时,要不要先问你?",
    "q.approval.explain": [
      "默认是「需要批准」:不在预放行名单里的命令会停下来等你处理",
      "(npm run ctl -- pending 看,approve / deny 处理)。没人处理 = 自动拒绝。",
      "",
      "另一个选择是「完全放行」:命令允许名单、链式命令护栏(&&、|、;)、",
      "以及文件工具的工作区边界会一起失效。它是真的什么都不问 —— 不是「少问几次」。",
      "",
      "它有一道护栏:服务一重启就自动恢复成「需要批准」。也就是说你忘了关也没关系。",
    ],
    "q.approval.ask": "现在就打开完全放行吗?(y/N,默认 N)",
    "q.approval.off": "按「需要批准」来。想换随时:npm run auto:on(想立刻收回:npm run auto:off)",
    "q.approval.on": "记住这个选择,等服务起来之后再打开 —— 服务没跑时开它是无效的,一启动就被清掉。",

    "start.title": "启动",
    "start.reload": "服务已经在跑 —— 重启它来读新的 .env(隧道不动,公网地址不变)。",
    "start.enable": "插件之前是停用状态,先解除。",
    "start.secret": "生成了 MCP_PATH_SECRET —— 就是 URL 里那一段随机字符,它就是密码。",
    "start.preflight": "启动前检查没过:",
    "start.local": "启动本地服务…",
    "start.tunnel": "启动隧道…",
    "start.autoOn": "打开完全放行…",
    "start.failed": "修完重跑 npm run setup 就行 —— 已经写进 .env 的部分不会白费。",

    "done.title": "接下来,只有三步:",
    "done.steps": [
      "  1. 打开 ChatGPT 网页版(chatgpt.com —— 桌面客户端和手机 App 没有这个入口)",
      "  2. Settings → Plugins → MCP → Add server",
      "  3. 类型选 Streamable HTTP,鉴权选 No authentication / 无鉴权,URL 粘上面那个",
    ],
    "done.tools": [
      "填完点进那个 server,能看到三个工具就说明通了:",
      "  deepseek_flash        一问一答,不碰你的文件",
      "  deepseek_agent_start  派一个能读写文件、能执行命令的子代理",
      "  deepseek_agent_poll   用 job_id 取它的结果",
    ],
    "done.later": [
      "以后改哪一项都不用重跑这个向导:",
      "  npm run ctl -- status        看状态(进程、审批模式、公网地址)",
      "  npm run ctl -- allow         加减工作区目录",
      "  npm run auto:on / auto:off   切审批模式",
      "  npm run ctl -- url           把地址重新复制到剪贴板",
    ],
    "done.safety": [
      "最后一句:那个带一长串随机字符的 URL 就是密码 —— 不要发给别人、不要贴在公开的地方。",
      "再去你模型服务商的控制台给这把 key 单独设一个消费上限,那是最后一道防线。",
    ],

    "abort.eof": "输入结束了(EOF),向导退出。已经写好的部分留在 .env 里。",
    "abort.cancel": "已退出,没有继续。",
    "invalid.choose": "请输入 {options} 里的一个数字。",
    "q.choose": "选一个(回车 = 第 1 项):",
  },

  en: {
    "banner.title": "ModelBridge first-run setup",
    "banner.intro": [
      "This wizard asks a few questions, writes .env, brings up the service and",
      "the tunnel, and hands you the URL to paste into your MCP host.",
      "",
      "· It only uses what you type — it does not scan your machine or guess.",
      "· The API key goes into .env and is never printed to the screen.",
      "· Ctrl+C quits; anything already written stays, and you can rerun it.",
    ],

    "dep.title": "Prerequisite: dependencies",
    "dep.found": "node_modules is already there — skipping.",
    "dep.missing": [
      "Dependencies are not installed yet (express / zod / the MCP SDK). This one",
      "step needs the network and takes a minute or two.",
      "The wizard itself does not need them — that is why it can run now — but the",
      "server does.",
    ],
    "dep.ask": "Install now? (Y/n, default Y)",
    "dep.running": "Running npm install …",
    "dep.failed": [
      "npm install failed. If this is a network problem, try a mirror:",
      "  npm config set registry https://registry.npmmirror.com",
      "then run npm run setup again.",
    ],
    "dep.skipped": "Skipped. The service will not start, so a later step will fail — you can install then.",

    "q.model.title": "[1/5] Which model?",
    "q.model.explain": [
      "The bridge's brain can be any model that speaks the Anthropic wire format —",
      "it does not have to be DeepSeek. DeepSeek is just the default: cheap, good",
      "enough, and from a different vendor than the caller, which is the point when",
      "you are using it for independent review.",
    ],
    "q.model.option1": "DeepSeek (default, https://api.deepseek.com)",
    "q.model.option2": "Another Anthropic-compatible endpoint (you supply the URL and model name)",
    "q.model.choose": "Choose one (default 1):",
    "q.model.base": "Base URL of the endpoint (like https://api.example.com — no /anthropic, no /v1):",
    "q.model.baseBad": "That does not look like an http(s) URL.",
    "q.model.baseStripped": "Dropped the trailing /anthropic — the bridge adds that itself.",
    "q.model.model": "Model name (for example deepseek-flash):",
    "q.model.modelBad": "The model name cannot be empty.",
    "q.model.apikey": "Paste the API key (input is not echoed):",
    "q.model.apikeyEmpty": "No key read.",
    "q.model.apikeyShape": "Note: this key does not start with sk-. DeepSeek's always do; other vendors' may not — continue if you are sure it was pasted correctly.",
    "q.model.probing": "Checking it with a minimal request (a few tokens)…",
    "q.model.ok": "✅ Works: {model} answered.",
    "q.model.badKey": "❌ The endpoint rejected this key (HTTP {status}). Usually a truncated paste, or a revoked key.",
    "q.model.badBase": "❌ HTTP 404. At least one of the endpoint and the key is wrong — a 404 is normally the address (a missing path segment).",
    "q.model.badRequest": "❌ HTTP {status}. The address and the key both worked, but the request was rejected — most often an unknown model name: {model}.",
    "q.model.rateLimited": "⚠️ HTTP 429: the key authenticated, it is just rate limited right now. Safe to continue.",
    "q.model.server": "❌ HTTP {status}: their server is failing, not your configuration. Try again later.",
    "q.model.network": "❌ Could not reach that address: {detail}",
    "q.model.unknown": "❌ HTTP {status}.",
    "q.model.detail": "   Their response: {detail}",
    "q.model.retry1": "Enter it all again (base URL, model name, key)",
    "q.model.retry2": "Save it anyway",
    "q.model.retry3": "Quit the wizard",
    "q.model.saved": "Wrote to .env: DEEPSEEK_API_KEY=<hidden, {length} characters>",
    "q.model.savedAnyway": "Saved as given. If it turns out not to work, rerun npm run setup.",

    "q.harness.title": "[2/5] Which harness runs the model?",
    "q.harness.explain": [
      "The harness is the thing that actually does the work: it owns the tools",
      "(read/write files, run commands), the multi-step loop, context compaction,",
      "and the approval gate. The model is only its brain.",
      "",
      "This project implements exactly one harness today: Claude Code. Once your",
      "model is swapped in, Claude Code becomes a shell — the loop and the tools",
      "are still its, but every inference goes to the endpoint you just filled in,",
      "at that endpoint's prices. Nothing is billed to Anthropic.",
      "",
      "So there is nothing to choose here — only to confirm it is findable on this",
      "machine.",
    ],
    "q.harness.found": "✅ Found Claude Code: {path}",
    "q.harness.missing": [
      "❌ Claude Code was not found. Without it, only deepseek_flash (plain",
      "   question and answer) works; both agent tools fail.",
      "",
      "   Install: npm i -g @anthropic-ai/claude-code",
      "   Still not found afterwards? Put the executable's full path here, or set",
      "   BRIDGE_CLAUDE_BIN in .env by hand.",
    ],
    "q.harness.askPath": "Full path to Claude Code (Enter to skip):",
    "q.harness.pathSaved": "Wrote to .env: BRIDGE_CLAUDE_BIN={path}",
    "q.harness.pathBad": "No such file, nothing written: {path}",
    "q.harness.skip": "Skipped — install it and come back.",

    "q.roots.title": "[3/5] Which directories may the sub-agent work in?",
    "q.roots.explain": [
      "Empty = every path is refused, and the bridge is read-only: question and",
      "answer only, it cannot touch your files.",
      "",
      "Filling this in hands those directories over — anyone holding the public URL",
      "can read files, change files, and run commands inside them. \"Can run",
      "commands\" means \"has this computer\".",
      "",
      "To start with the read-only tier, just press Enter. You can add one later:",
      "  npm run ctl -- allow \"D:\\project\"",
    ],
    "q.roots.ask": "Directory to hand over (Enter = skip):",
    "q.roots.danger": "Refused: {path} is {what} — that hands over the whole machine. Pick a specific project directory.",
    "q.roots.notfound": "That path does not exist, nothing written: {path}",
    "q.roots.added": "Wrote to .env: DEEPSEEK_ALLOWED_ROOTS={roots}",
    "q.roots.skip": "Staying read-only.",
    "q.roots.keep": "Nothing added. These were already configured and stay in effect: {roots}",
    "q.roots.warn": "⚠️  Anyone holding the URL can now read and write files in those directories, and run commands there.",

    "q.tunnel.title": "[4/5] Temporary hostname or a fixed one?",
    "q.tunnel.explain": [
      "Your MCP host has to reach this machine, so there is a Cloudflare tunnel in",
      "between. Two kinds:",
      "",
      "  1) Quick tunnel (default) — zero config, but Cloudflare hands out a random",
      "     hostname on every start; when it changes you must edit the connector URL.",
      "  2) Fixed hostname — your own domain, the address never changes, and the",
      "     connector is created once. Requires a domain whose NS already points at",
      "     Cloudflare, otherwise the dashboard step cannot be added.",
    ],
    "q.tunnel.option1": "Quick tunnel (default)",
    "q.tunnel.option2": "Fixed hostname (needs your own domain + Cloudflare)",
    "q.tunnel.choose": "Choose one (default 1):",
    "q.tunnel.host": "Your hostname (like mcp.example.com — no https://):",
    "q.tunnel.hostBad": "\"{host}\" does not look like a hostname. Expected something like mcp.example.com.",
    "q.tunnel.tokenExplain": [
      "A tunnel token is needed. Get it from the Cloudflare dashboard:",
      "  Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared",
      "  The page then shows a long token. (Already created it? Open the tunnel →",
      "  Configure and the token is there too.)",
    ],
    "q.tunnel.tokenAsk": "Paste the token (input is not echoed):",
    "q.tunnel.tokenShort": "That is only {n} characters — not a whole token (usually 150+). A paste almost certainly got cut short.",
    "q.tunnel.saved": "Wrote to .env: TUNNEL_MODE=named / TUNNEL_HOSTNAME={host} / TUNNEL_TOKEN=<hidden>",
    "q.tunnel.dnsNote": [
      "⚠️  One step is left, and it can only be done on Cloudflare's website:",
      "     Zero Trust → Networks → Tunnels → this tunnel → Public Hostname → Add",
      "     subdomain {sub} / domain {domain} / service HTTP / URL localhost:{port}",
      "   Without it the tunnel reports itself connected but the domain 404s.",
      "   Check it afterwards with: npm run ctl -- tunnel check",
    ],
    "q.tunnel.quick": "Using a quick tunnel. The hostname it gets is printed below — it changes on restart; when it does, run npm run ctl -- url.",

    "q.approval.title": "[5/5] Should the sub-agent ask before running commands?",
    "q.approval.explain": [
      "The default is \"needs approval\": a command outside the pre-approved list",
      "stops and waits for you (npm run ctl -- pending, then approve / deny).",
      "Nobody answers = automatic denial.",
      "",
      "The other option is full bypass: the command allowlist, the chaining guard",
      "(&&, |, ;) and the file tools' workspace boundary all stop applying. It",
      "really asks nothing — it is not \"fewer prompts\".",
      "",
      "It has one guardrail: restarting the service turns it back off. So forgetting",
      "about it is not permanent.",
    ],
    "q.approval.ask": "Turn full bypass on now? (y/N, default N)",
    "q.approval.off": "Staying with \"needs approval\". To switch: npm run auto:on (to revoke: npm run auto:off)",
    "q.approval.on": "Noted — it will be switched on once the service is up. Turning it on while the service is down does nothing: the next start clears it.",

    "start.title": "Starting",
    "start.reload": "The service is already running — restarting it to pick up the new .env (the tunnel is left alone, so the public URL does not change).",
    "start.enable": "The plugin was disabled; enabling it first.",
    "start.secret": "Generated MCP_PATH_SECRET — the random run of characters in the URL. That is the password.",
    "start.preflight": "Preflight failed:",
    "start.local": "Starting the local server…",
    "start.tunnel": "Starting the tunnel…",
    "start.autoOn": "Turning on full bypass…",
    "start.failed": "Fix it and rerun npm run setup — what is already in .env is kept.",

    "done.title": "Three steps left:",
    "done.steps": [
      "  1. Open ChatGPT in a browser (chatgpt.com — the desktop and mobile apps have no such setting)",
      "  2. Settings → Plugins → MCP → Add server",
      "  3. Type: Streamable HTTP, Authentication: No authentication, URL: paste the one above",
    ],
    "done.tools": [
      "Open that server afterwards; three tools means it worked:",
      "  deepseek_flash        question and answer, cannot touch your files",
      "  deepseek_agent_start  dispatch a sub-agent that can read, write and run commands",
      "  deepseek_agent_poll   fetch its result by job_id",
    ],
    "done.later": [
      "Nothing here needs the wizard again later:",
      "  npm run ctl -- status        state: process, approval mode, public URL",
      "  npm run ctl -- allow         add or remove a workspace root",
      "  npm run auto:on / auto:off   switch the approval mode",
      "  npm run ctl -- url           put the URL on the clipboard again",
    ],
    "done.safety": [
      "One last thing: that URL with the long random string in it IS the password — do not",
      "send it to anyone or paste it anywhere public. Then set a spending limit on this key",
      "in your model provider's console; that is the last line of defence.",
    ],

    "abort.eof": "Input ended (EOF); the wizard stopped. What was already written stays in .env.",
    "abort.cancel": "Stopped; nothing further was done.",
    "invalid.choose": "Enter one of {options}.",
    "q.choose": "Choose one (Enter = the first):",
  },
};

/** Every key in the table — the test asserts both languages define exactly these. */
export function messageKeys() {
  return Object.keys(MESSAGES.zh);
}

/**
 * Look up a line, with `{name}` interpolation.
 *
 * Throws on an unknown key on purpose: a typo here would otherwise print
 * `undefined` in the middle of an instruction a stranger is following, which is
 * worse than a crash during `npm test`.
 */
export function t(lang, key, vars) {
  const table = MESSAGES[normalizeLang(lang) ?? "en"] ?? MESSAGES.en;
  const value = table[key];
  if (value === undefined) throw new Error(`setup: no message for "${key}"`);
  const fill = (s) =>
    String(s).replace(/\{(\w+)\}/g, (whole, name) =>
      vars && name in vars ? String(vars[name]) : whole,
    );
  return Array.isArray(value) ? value.map(fill) : fill(value);
}

/** DeepSeek's own defaults — the same two values `src/deepseek.ts` falls back to. */
export const PROVIDER_PRESETS = {
  deepseek: { base: "https://api.deepseek.com", model: "deepseek-flash" },
};

/**
 * Where the Claude Code CLI lands when npm installs it globally, relative to
 * the home directory.
 *
 * `src/harness/claude-code.ts` (`resolveBin`) holds the same two paths, and it
 * cannot be imported from here: it pulls in the MCP SDK, and the wizard has to
 * run *before* `npm install` — on a fresh clone it is the only thing that works.
 * So the list is duplicated by hand, and `test-setup.mjs` reads that file to
 * make sure the two have not drifted apart.
 */
export const CLAUDE_BIN_RELATIVE = [".local/bin", ".claude/local"];

export function claudeExeName(platform = process.platform) {
  return platform === "win32" ? "claude.exe" : "claude";
}

/**
 * The address the *harness* talks to.
 *
 * The flash tool and the harness take two different values out of one
 * `.env`: `src/deepseek.ts` appends `/chat/completions` to `DEEPSEEK_BASE_URL`,
 * while `claude-code.ts` appends `/anthropic` to it (unless
 * `BRIDGE_ANTHROPIC_BASE_URL` overrides). The wizard asks for the former — one
 * value that serves both — and has to derive the latter exactly the way the
 * harness will, or it would validate an endpoint nobody ever calls.
 */
export function anthropicBase(providerBase, override) {
  const explicit = String(override ?? "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return `${String(providerBase ?? "").trim().replace(/\/+$/, "")}/anthropic`;
}

/**
 * `/v1/messages` on top of an Anthropic base, without doubling a `/v1` the
 * operator already put in the URL. Someone whose endpoint really is documented
 * as `https://host/anthropic/v1` should not be told their key is invalid.
 */
export function messagesUrl(base) {
  const clean = String(base ?? "").trim().replace(/\/+$/, "");
  return /\/v1$/.test(clean) ? `${clean}/messages` : `${clean}/v1/messages`;
}

/** Strip what people paste in by habit — the URL is built from the bare host. */
export function normalizeHost(value) {
  return String(value ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function looksLikeHost(value) {
  const host = normalizeHost(value);
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host);
}

export function looksLikeHttpUrl(value) {
  return /^https?:\/\/[^\s/]+/i.test(String(value ?? "").trim());
}

/**
 * What a probe response means, as a code rather than a sentence — so the
 * wording lives in the message table and this stays testable.
 *
 * `status === 0` is the caller's marker for "the request never completed".
 */
export function classifyProbe(status) {
  if (status === 0) return "network";
  if (status === 200 || status === 201) return "ok";
  if (status === 401 || status === 403) return "badKey";
  if (status === 404) return "badBase";
  if (status === 429) return "rateLimited";
  if (status === 400 || status === 422) return "badRequest";
  if (status >= 500) return "server";
  return "unknown";
}

/**
 * A 429 proves the credential authenticated — the limit is checked after auth —
 * so it is a usable configuration, just a throttled one. Anything else that is
 * not 2xx is a real problem.
 */
export function probeUsable(code) {
  return code === "ok" || code === "rateLimited";
}

/**
 * What may be said about a key on screen.
 *
 * Length and the `sk-` shape, never the value, not even a prefix/suffix. The
 * length is the part that catches a truncated paste, which is the actual
 * failure mode; four characters of a live credential buy nothing that is worth
 * a copy in somebody's scrollback.
 */
export function keySummary(key) {
  const value = String(key ?? "");
  return { length: value.length, looksDeepSeek: value.startsWith("sk-") };
}

/** Truncate a response body for display; `ctl.mjs` masks it before printing. */
export function shortDetail(text, limit = 200) {
  const one = String(text ?? "").replace(/\s+/g, " ").trim();
  return one.length > limit ? `${one.slice(0, limit)}…` : one;
}
