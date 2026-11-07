# 各站点抓取细节

记录三个站的实测接口、字段与坑。改代码前先读这里。

## claude.ai/share/&lt;uuid&gt;

**通道：browser**

HTML 直连能拿到 200（约 158 KB），但里面**没有对话正文**。只有一段引导代码说明数据从哪来：

```js
`/api/chat_snapshots/${e}?rendering_mode=messages&render_all_tools=true&renders_source_card=true&renders_tally_table_bars=true`
```

同时会塞一个空壳 `window.__PUBLIC_VIEWER_PRELOAD__ = { responses: {} }`。

直连该接口的结果是 **403 + Cloudflare 挑战页**（HTML 形式的 `Just a moment...`），不是 JSON。所以必须在浏览器里执行 fetch，靠 cf cookie 过。

页面内 fetch 返回的顶层字段：

```
uuid, conversation_uuid, created_at, updated_at, snapshot_name, created_by, creator,
project_uuid, chat_messages, up_to_date, is_public, viewer_can_access_files, working_documents
```

`chat_messages[i]` 字段：`uuid, text, content[], sender, index, created_at, updated_at, input_mode, truncated, stop_reason, compaction_summary, attachments, files, parent_message_uuid, image_count, file_count, attached_folders, local_project`

`content[]` 里 `type: "text"` 的元素带 `text` 字段，是 markdown 原文。`sender` 为 `human` 或 `assistant`。

注意 `message.text` 顶层字段常为空字符串，正文在 `content[].text`，别取错。

分享者名字在页面上被匿名化成单字母（示例里是「由 R 分享」），接口里 `creator` 仍有信息，但没有进文档，隐私考虑。

## chatgpt.com/share/&lt;uuid&gt;

**通道：http**

`https://chatgpt.com/backend-api/share/<uuid>` 免认证，返回完整 JSON（示例 199 KB）。本机直连 2.6 s，不需要显式挂代理。

顶层字段里有用的是 `title`、`mapping`、`current_node`。`mapping` 是节点字典（键为节点 id），每个节点有 `parent`、`children`、`message`。

主链取法：从 `current_node` 沿 `parent` 回溯到根，再反转。

过滤规则（三条都要）：

1. `message.author.role` 只留 `user` 和 `assistant`
2. `message.content.content_type === "text"`
3. `message.metadata.is_visually_hidden_from_conversation !== true`

第 3 条对应的实际案例：`Original custom instructions no longer available` 这条在数据里是 `role: user`、`content_type: text`，但页面不显示。漏了这条会把文档消息数从 8 变 9。

`content.parts` 是字符串数组，即 markdown 原文。

`/backend-api/conversation/<uuid>` 是另一个接口，需要认证，返回 401。别用混。

## workbuddy.link/p/&lt;id&gt;

**通道：http**

外层页面会 301 到 `www.workbuddy.link`，跟随后 200，约 5.6 KB。HTML 里内嵌：

```js
window.__PUBLISH_BOOTSTRAP__ = {"nodeId":"...","artifact":{"artifacts":[{"path":"conversation-data.json"},{"path":"index.html"}],"url":"https://workbuddy-space-static.codebuddy.work/page/<id>/<hash>/","creator":"...","publishVersion":...}}
```

`artifact.url` 结尾带斜杠，拼上 `conversation-data.json` 就是完整对话（示例 197 KB）。这一步不需要执行 JS，也不需要 iframe。

数据结构：

```
version, name, assistantName, theme, messages[], artifactMap, messageTimeWindows
messages[i] = { id, conversationId, requestId, messageType: "user"|"assistant",
                content: [{ type: "text"|"reasoning"|"tool-call", text }], complete, createTime }
```

`content[].text` 里 `type: "text"` 的是 markdown 原文；`type: "reasoning"` 是思考过程；`type: "tool-call"` 是工具调用，默认都不取。

`createTime` 是毫秒时间戳，`messageTimeWindows` 里另有按消息分组的时间窗。

正文页是 `index.html` + `/page/page_comm/page_comm` 风格的 SPA 壳，`body.innerText` 初始为空，内容由 JS 渲染。所以如果走浏览器通道，必须等渲染完成。

## opencli 后端的使用约束

只有走 opencli 后端时相关。用 cdp 后端（默认在没有 opencli 的机器上）没有这些限制，页面脚本直接 Runtime.evaluate 执行。

这些是全流程实测出来的，不是猜测：

| 现象 | 原因 | 规避 |
| --- | --- | --- |
| `'iframe'` 变成 `iframe`，报 ReferenceError | opencli eval 吃单引号 | 一律 base64 注入页面脚本 |
| 表达式超约 5k 字符报 `SyntaxError: Invalid or unexpected token` | 参数长度上限 | 按 3000 字符分片写进 `window.__csr` |
| `JSON.stringify({x:1})` 报 `missing ) after argument list` | 表达式里的 `{}` 被处理 | 同上，base64 注入天然绕过 |
| URL 里的 `&` 被当命令分隔符 | 走了 shell:true | `execFile('bash', [OPENCLI, ...])` 且 `shell: false` |
| `attach failed: Cannot access a chrome-extension:// URL` | 扩展临时失联 | 重试 4 次，间隔 2.5 s |
| `opencli browser <s> frames` 返回空数组 | 未实现跨域 iframe 枚举 | 从 HTML 正则取 iframe src |

opencli 的探测顺序是 `OPENCLI_BIN` → `~/.chat-share-reader/config.json` 的 `opencliBin` → `~/bin/opencli` → `/usr/local/bin/opencli` → `/opt/homebrew/bin/opencli` → PATH。Windows 上它常是 git-bash 包装脚本，脚本内部再 exec node，所以调用方必须经 bash 且 `shell:false`。

## cdp 后端：为什么用真 Chrome

不装任何 npm 包，用 Node 22 内置的 `WebSocket` 直连 Chrome/Edge 的 DevTools 协议。核心判断是「用真浏览器二进制 + 持久 profile」，不伪造任何东西。

实测（2026-11-07）：

| 方案 | claude.ai | perplexity.ai | grok.com |
| --- | --- | --- | --- |
| Playwright 自带 Chromium（headless，UA 伪装） | 通过 | 挑战页 | 挑战页 |
| 真 Chrome + 全新 profile（有头） | 通过 | 挑战页 | 挑战页 |
| 真 Chrome + 有访问历史的 profile | 通过 | 通过 | 通过 |

结论：Cloudflare 判定的是 profile 信誉，不是 UA，也不是「是不是自动化」。所以 cdp 后端的策略是不伪装，遇到挑战时提示人工过一次，cookie 留在持久 profile 里，后续自动。

这个设计有个直接后果：**别人第一次用会有一次人工成本**，集中在 Perplexity 和 Grok 两站。Claude 在全新 profile 下也能直接过。

## gemini.google.com/share 与 share.gemini.google

**通道：vendor 优先，DOM 兜底**

三种链接形态指向同一会话，但 id 位置不同：

| 形态 | id |
| --- | --- |
| `gemini.google.com/share/<id>` | 路径里就是会话 id，12 位 hex |
| `g.co/gemini/share/<id>` | 同一个 id，只是路径别名 |
| `share.gemini.google/<token>` | 真短链，token 不是 id，要跟一次 301 才能拿到 |

页面 HTML 873 KB，`AF_initDataCallback` 只是空壳定义，没有数据。正文由 Angular 客户端渲染，数据来自 batchexecute：

```
POST https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=ujx1Bf
Content-Type: application/x-www-form-urlencoded;charset=UTF-8

f.req=[[["ujx1Bf","[null,\"<conversation_id>\",[4]]",null,"generic"]]]&at=
```

实测直连返回 200，73 KB，无 Cloudflare。响应体以 `)]}'` 开头，之后是一串 `<length>\n<frame>`，每个 frame 是 JSON 数组，`wrb.fr` 行的 index 1 是 rpc id、index 2 是 JSON 字符串（要二次 decode）。声明的 length 不可信，它既不是字符数也不是 UTF-8 字节数，按它切会截断 frame，正确做法是忽略长度直接从 JSON 起点解析。

两个已知陷阱：

- 不存在的 share 返回 200，`wrb.fr` 的 payload 是 null。状态码分不出「缺失」和「成功」，必须检查 body。
- 渲染后的 DOM 结构是 `share-turn-viewer > user-query(.query-text-line) + response-container`，没有 Shadow DOM，能直接 querySelectorAll。用户消息取 `.query-text-line` 的 innerText，`user-query` 整体取会拿到隐藏的重复副本。

Gemini 分享页没有对话标题，DOM 路径只能用首问截断当文件名，接口路径能拿到真标题。

## grok.com/share

**通道：vendor 优先，DOM 兜底**

页面是 Next.js + RSC，SSR 数据里只有 `shareLinkId`，正文由客户端二次请求。接口：

```
GET https://grok.com/rest/app-chat/share_links/<share_id>
```

`share_id` 是 base64 前缀 + 下划线 + UUID，前缀见过 `legacy`、`legacy-copy`、`shard-2`，含义不明，当作不透明字符串处理。

**本机实测这条接口即使页面能打开也返回 403**：浏览器过挑战后页面正常渲染（3087 字符），同一时刻 curl 打接口仍是 `Just a moment`。说明页面通道与接口通道是两套判定，页面能开不代表接口能拿。所以这一站实际走 DOM 渲染，convolvger 的 vendor 通道长期不可用。

渲染后的 DOM 结构（2026-11-07 实测一条 2 轮分享）：

```
[data-testid="share-transcript-scroller"]        容器
  [data-testid="user-message"]                   用户，内含 <h2 class="sr-only">你</h2> 标签
  [data-testid="assistant-message"]              助手，内含 sr-only 的 "Grok" 标签
```

两者在 DOM 里按对话顺序交错，一条组合选择器取回即是时间序。`sr-only` 那类无障碍标签必须排除，否则每条消息前面会多出一行「你」或「Grok」，看起来像重复的角色标题。

失败形态（Convolvger 记录，供判断用）：未知或已删分享返回 404 `{"code":5,"message":"Cannot find conversation."}`，UUID 段畸形的返回 400 `Invalid uuid.`，还有一种是 200 但 `responses` 为空只带标题。

## 实测汇总（2026-11-07）

从 GitHub 代码搜索捞真实分享链接逐条实测：

| 站点 | 样本 | 结果 | 耗时 | 通道 |
| --- | --- | --- | --- | --- |
| chat.deepseek.com/share | 5 | 4 成 1 失效 | 1.5 s | vendor |
| kimi.com/share | 4 | 4 成 | 1.6 s | vendor |
| chat.qwen.ai/s | 3 | 3 成 | 2.5 s | vendor |
| perplexity.ai/search | 3 | 成（自写解析） | 15 s | browser |
| grok.com/share | 3 | 时段性 403 | - | browser |

各站特征：

- **DeepSeek**：所有分享的标题都是 `Shared Conversation`，多份导出会撞名，必须加 id 后缀。引用写成 `[citation:3]`。
- **Kimi**：消息多时 warning 多（tool block 未建模），但正文完整。标题正常（如 `直接完成`）。
- **Qwen**：代码块保留完好，一次 6 条消息的样本里有 22 个围栏。引用写成 `[[3]]`，代码里的 `x = [[3]]` 是嵌套列表不要动。
- **Perplexity**：见下一节，vendor 的适配已过时，要自己解析。
- **Grok**：见上一节。

**Convolvger 的退出码语义**：只要抽取过程有 warning（未建模的 tool block、提供商撤销的消息、文件块等），进程返回非零退出码，但内容已经完整产出。判成败必须看 stdout 有没有 `Provider:` 行、输出文件存不存在，不能看 exit code。`lib/vendor.mjs` 已按这个规则处理，改之前先想清楚。

## perplexity.ai/search

**通道：browser，自写解析（不用 vendor）**

页面打开后 URL 会从 `/search/<id>` 跳到 `/session/<id>`，但接口路径和 provider 匹配都只认 `/search/`，POST 给 Convolvger 的 capture 服务时报的 URL 也必须是 `/search/` 形态，否则它按 provider 拒绝。

接口：

```
GET /rest/thread/<id>?with_parent_info=true&with_schematized_response=true&version=2.18&source=default
    &limit=20&offset=0&from_first=false&with_first_entry=true&with_latest_entry=false
    &supported_block_use_cases=...（27 个，见 scripts/sites/perplexity.mjs）
```

**参数必须带全那 27 个 `supported_block_use_cases`**。只带前几个时接口照样 200，也照样返回 57 KB 数据，但回答正文所在的 `ask_text_0_markdown` 块根本不会下发，只剩下问题。这是最费时间的一个坑：数据量看着正常，内容却是空的。

数据结构：

```
{entries: [...], first_entry, latest_entry, has_next_page, next_cursor, thread_metadata}
entries[i].blocks[] = {intended_usage, <block 类型对应的字段>}
  intended_usage == "ask_text_0_markdown" → markdown_block.answer（也有 chunks[]，join 后等长）
  intended_usage == "web_results"         → web_result_block.web_results[]，每项字段是 name 和 url
  intended_usage == "plan"                → plan_block（搜索计划，不是答案）
```

几个易错点：

- `markdown_block` 是对象不是字符串，直接 String() 会得到 `[object Object]`
- 每个 entry 的答案在 `ask_text_0_markdown` 里，`ask_text` 那份是同一段文字的碎片化版本（按显示字符切），拼起来会掺进多余换行
- 来源项的标题字段是 `name`，不是 `title`，写 `w.title` 会全部过滤掉
- 正文里的 `[n]` 是 Perplexity 自己的编号，与 `web_results` 顺序不对应，所以来源单独列一份，不冒充编号映射
- `has_next_page` 为真表示超过 20 轮，只拿到第一页

Convolvger 0.7.0 的 Perplexity 适配停留在旧结构：它认 `entries[].text` 里的 step 流，而当前接口给的是 `entries[].blocks`。所以它对这条真实链接能报出标题和时间，但正文只有问题，warning 写 `unmodelled_content_type: ask_text_0_markdown`。这就是为什么这一站要自己写解析，而不是 vendor 优先。

## 关于 Cloudflare：是临时风控，不是 cookie 问题

2026-11-07 观察到的现象与最初猜测不符，记下来避免后面的人再走错：

- `claude.ai` 一直能打开。用户的账号已被封、日常也不访问这个站，浏览器里没有该站的 `cf_clearance`。所以「能过是因为有通行 cookie」这个假设不成立。
- `grok.com` 有一段时间整站返回挑战页（首页和 share 页都拦，换 UA 无效），约一小时后自行恢复，恢复后同一条命令直接成功，期间没有做任何登录或过验证操作。
- `perplexity.ai` 在同样时段也拦。

结论：这是 Cloudflare 按 IP 或时段做的临时风控，会自行解除。不是配置问题，不是 cookie 问题，也不是代码问题。

遇到时的正确反应：等一会儿重试，或者换个出口。不要花时间去调整 UA、headers、请求频率，这些都不影响结果。

另有一条实测差异值得记：即使浏览器页面能打开，`grok.com/rest/app-chat/share_links/<id>` 这个接口用无 cookie 的 curl 请求仍然 403。也就是说 Grok 的浏览器通道和接口通道是两套判定，页面能开不代表接口能拿。所以 Grok 的 vendor 通道长期不可用，实际走的是 DOM 渲染。

## 同类方案调研（2026-11-07，两轮）


第一次只搜到 csctf，第二轮才发现 Convolvger 才是正解。教训是：搜「share link to markdown」这类需求时，PyPI 和 dev.to 上的实践文章比 GitHub 仓库搜索更容易命中。

| 项目 | 形态 | 覆盖 | 采用 |
| --- | --- | --- | --- |
| `bilalmughal1/convolvger`（PyPI `convolvger` 0.7.0） | Python CLI，本地优先 | ChatGPT / Claude / Gemini / Grok / DeepSeek / Kimi / Qwen / Perplexity | 是，主通道 |
| `Dicklesworthstone/chat_shared_conversation_to_file`（csctf） | Bun CLI + Playwright | ChatGPT / Gemini / Grok / Claude | 否 |

不采用 csctf 的原因：走 DOM + Turndown 重建，保真度低于接口原文；需要 Bun 1.3+ 和 Playwright Chromium；Claude 那条要复制 Chrome cookie 并重启浏览器；覆盖比 Convolvger 少 4 站。

Convolvger 在实测中的具体表现：

- Gemini：可用，返回真标题、12 条消息、每条消息原始时间戳，纯 HTTP 无浏览器
- ChatGPT：**失效**，报 `No turbo-stream payload found in source`，它依赖页面里的 RSC 数据，当前分享页已不含。这一站继续用本 skill 的 `backend-api/share`
- Grok：报 `Access refused`，与本机 403 一致，无法判断是链接私有还是 CF
- WorkBuddy：不支持，报 `No provider matches URL`
- Claude / Perplexity：需要 bookmarklet 在浏览器里手工交接，不适合 agent 自动跑

所以分工是：Gemini 交出去，ChatGPT / Claude / WorkBuddy 自己留着，Grok 两条路都试。

其他命中都是别的形态，不解决「给一条分享链接」这个输入：

- 浏览器扩展（导出自己账号的历史）：`pionxzh/chatgpt-exporter` 2862★、`agarwalvishal/claude-chat-exporter` 743★、`socketteer/Claude-Conversation-Exporter` 133★
- 本地会话导出：`workbuddy-conversation-reader` 1★、`conversation-export-skill` 0★、`AgentHandoff` 2★
